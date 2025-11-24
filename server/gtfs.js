import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { readFileSync, existsSync } from 'fs';
import { Train } from './Train.js';
import { exit } from 'process';
import unzipper from 'unzipper';

if (!process.env.API_KEY) {
    console.error('No API key!');
    exit(1);
}

const shapes = JSON.parse(readFileSync('shapes.json', 'utf8'));
const points = JSON.parse(readFileSync('points.json', 'utf8'));

// Download static GTFS files if they aren't already downloaded
if (!existsSync('gtfs')) {
    console.log('Downloading GTFS static files');
    const buf = await fetch('https://www.bart.gov/dev/schedules/google_transit.zip').then(res => res.arrayBuffer());
    const directory = await unzipper.Open.buffer(new Uint8Array(buf));
    await directory.extract({ path: 'gtfs' });
}

export const stops = readFileSync('gtfs/stops.txt', 'utf8')
    .split('\r\n').slice(1).map(l => l.replaceAll('"', '').split(',')).filter(s => s[0].includes('-') || s[0].length === 3 /* XNN-N or XNN */);
// stop_id,stop_code,stop_name,stop_desc,stop_lat,stop_lon,zone_id,plc_url,location_type,parent_station,platform_code
export const idToStation = id => {
    for (let i = 0; i < stops.length; i++)
        if (stops[i][0] === id)
            return stops[i][2];
};
const abbreviationToId = abbr => {
    for (let i = 0; i < stops.length; i++)
        if (stops[i][9] === abbr)
            return stops[i][0].substring(0, 3);
}

export const stopTimes = readFileSync('gtfs/stop_times.txt', 'utf8')
    .split('\r\n').slice(1, -1).map(l => l.split(','))
// trip_id,arrival_time,departure_time,stop_id,stop_sequence,stop_headsign,pickup_type,drop_off_type,shape_distance_traveled
const SECONDS_PER_DAY = 60 * 60 * 24;
const stringTimeToSeconds = str => {
    // hh:mm:ss
    const parts = str.split(':');
    return parseInt(parts[0] * 3600) + parseInt(parts[1] * 60) + parseInt(parts[2]) + 8 * 3600 /* timezone offset */;
    // TODO: use timezone in agency.txt
};
/**
 * Finds the previous stop for a trip, or nothing if there is no previous stop.
 * Searches the static GTFS feed first, then looks back at the stops on the shape.
 * @param {String} tripId GTFS trip_id for train
 * @param {String} shape Shape identifier for trip
 * @param {String} firstStop Station code for train's first stop
 * @param {number} delay Delay in seconds of first stop
 * @param {number} time Current time
 * @returns {Object} Object in GTFS StopTimeUpdate structure
 */
const getPreviousStop = (tripId, shape, firstStop, delay, time, arrive) => {
    if (tripId.length === 3)
        // 6XX trains (eBART) always take 7 minutes
        return { // GTFS stop structure
            stopId: shape[2] === '1' ? 'E30-2' /* Yellow-S starting at Antioch */ : 'E20-1' /* Yellow-N starting at Pittsburg Center */,
            departure: {
                time: {
                    low: arrive - 420 + delay
                }
            }
        };

    for (let i = 0; i < stopTimes.length; i++) {
        if (stopTimes[i][0] === tripId) {
            if (stopTimes[i][3] === firstStop)
                // Stop is first, so there's nothing before it
                return;

            let stop;
            while (++i < stopTimes.length && (stop = stopTimes[i])[0] === tripId) {
                if (stop[3] === firstStop) {
                    const previous = stopTimes[i - 1];
                    const dayStart = time - (time % SECONDS_PER_DAY);
                    return { // GTFS stop structure
                        stopId: previous[3],
                        departure: {
                            time: {
                                low: Math.min(dayStart + stringTimeToSeconds(previous[2]) + delay, time)
                            }
                        }
                    };
                }
            }

            // Stop isn't scheduled
            break;
        }
    }

    // Stop or trip isn't scheduled so use shape
    const stops = shapes.find(s => s.shape === shape).stops;
    const prefix = firstStop.substring(0, 3);
    for (let i = 1; i < stops.length; i++)
        if (stops[i].startsWith(prefix))
            return { // GTFS stop structure
                stopId: stops[i - 1],
                departure: {
                    time: {
                        // TODO: if time goes over 70 mph, clamp it
                        low: time
                    }
                }
            };
};

export const trips = readFileSync('gtfs/trips.txt', 'utf8')
    .split('\r\n').slice(1).map(l => l.split(','));
// route_id,service_id,trip_id,trip_headsign,direction_id,block_id,shape_id,trip_load_information,wheelchair_accessible,bikes_allowed
export const getTripShape = (train, stopCount) => {
    let route;
    // Search static GTFS for trip
    for (let i = 0; i < trips.length; i++) {
        if (trips[i][2] === train.id) {
            if (trips[i][6])
                return trips[i][6];

            // If there's no Q48B-5JD9-924T-DWEIshape, pick a shape on the route
            route = trips[i][0].padStart(3, '0');

            break;
        }
    }

    // Make a guess of what shape fits route and stops
    const shapeChoices = shapes.filter(shape => !route /* check all if no route */ || shape.shape.startsWith(route));
    // Track place on each option
    const choiceIndices = {};

    for (const stop of train.tripUpdate.stopTimeUpdate) {
        // Loop label: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/label
        choiceLoop: for (let i = 0; i < shapeChoices.length; i++) {
            const choice = shapeChoices[i];

            for (let j = choiceIndices[choice.shape] || 0; j < choice.stops.length; j++) {
                if (choice.stops[j] === stop.stopId) {
                    choiceIndices[choice.shape] = j + 1;
                    continue choiceLoop;
                }
            }

            // Remove choices that don't have stops in order
            shapeChoices.splice(i, 1);
            i--;
        }
    }

    if (stopCount > 1)
        return shapeChoices[0].shape;

    // If the train only has one stop, choose a shape where that stop isn't the beginning
    const prefix = train.tripUpdate.stopTimeUpdate[0].stopId.substring(0, 3); // get station prefix
    for (let i = 0; i < shapeChoices.length; i++)
        if (!shapeChoices[i].stops[0].startsWith(prefix))
            return shapeChoices[i].shape;
};

export const routes = readFileSync('gtfs/routes.txt', 'utf8')
    .split('\r\n').slice(1).map(l => l.split(','))
    .reverse(); // start with longest routes first
// route_id,route_short_name,route_long_name,route_desc,route_type,route_url,route_color,route_text_color

const shapeLineMap = new Map(
    shapes.map(
        shape => [
            shape.shape,
            routes.find(
                route => shape.shape.includes(route[0]) // find route that matches shape name
            )[1] // return line name of route
        ]
    )
);

const etdUrl = 'https://api.bart.gov/api/etd.aspx?cmd=etd&orig=ALL&json=y&key=' + process.env.API_KEY;
const getTrainLengths = async () => {
    const etds = await fetch(etdUrl).then(res => res.json()).then(data => data.root.station)
    // Create map of lengths of trains departing from each station
    // Maps station to list of lines, which have the length for the train on them
    const trainLengths = {};
    for (const station of etds) {
        const lines = {};
        for (const destination of station.etd) {
            for (const line of destination.estimate) {
                // Loop through all in case of something unexpected in the first position
                const lineName = line.color[0] + line.color.substring(1).toLowerCase() + '-' + line.direction[0]; // Convert into GTFS line name
                const departure = lines[lineName] || {};
                const time = parseInt(line.minutes) || 0; // count "Leaving" as 0 minutes
                if (!departure.time || time < departure.time) {
                    departure.time = time;
                    departure.length = line.length;
                    lines[lineName] = departure;
                }
            }
        }
        trainLengths[abbreviationToId(station.abbr)] = lines;
    }

    return trainLengths;
}

export const updateTrains = async (trains, messageObject) => {
    const buf = await fetch('https://api.bart.gov/gtfsrt/tripupdate.aspx').then(res => res.arrayBuffer());
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buf));

    let trainLengths;

    let time = Date.now() / 1000;

    trainLoop: for (let i = 0; i < feed.entity.length; i++) {
        const trip = feed.entity[i];
        const tripId = trip.tripUpdate.trip.tripId;

        for (let j = 0; j < trains.length; j++) {
            if (trains[j].tripId === tripId) {
                const train = trains[j], updates = trip.tripUpdate.stopTimeUpdate;
                if (train.nextStation === undefined)
                    continue;

                let stopsLeft = train.stops.length + 1;
                for (let k = 0; k < updates.length && stopsLeft > 0; k++) {
                    const update = updates[k];

                    if (train.nextStation && update.stopId === train.nextStation.station) {
                        if (update.arrival.time.low <= time) { // If the nextStation has passed, update to the new nextStation
                            train.advanceStation(time);
                            train.departTime = time; // Don't stop if passed
                            continue;
                        }

                        const oldArrive = train.nextStation.arrive;
                        train.nextStation.arrive = update.arrival.time.low;
                        train.nextStation.depart = update.departure.time.low;
                        train.nextStation.delay = update.arrival.delay;
                        if (oldArrive !== update.arrival.time.low)
                            // Update speed if time changed
                            train.calculateSpeed(time);
                        continue;
                    }

                    for (let l = 0; l < train.stops.length; l++) {
                        if (train.stops[l].station === updates[k].stopId) {
                            const stop = train.stops[l];
                            stop.arrive = update.arrival.time.low;
                            stop.depart = update.departure.time.low;
                            stop.delay = update.arrival.delay;
                            break;
                        }
                    }
                }

                continue trainLoop;
            }
        }

        // No matching train found, add it
        const stops = [];
        let previousStop;
        for (let k = 0; k < trip.tripUpdate.stopTimeUpdate.length; k++) {
            const stop = trip.tripUpdate.stopTimeUpdate[k];

            // Skip stops that already happened
            if (trip.tripUpdate.stopTimeUpdate[k].departure.time.low < time) {
                previousStop = trip.tripUpdate.stopTimeUpdate[k];
                continue;
            }

            stops.push({
                station: stop.stopId,
                arrive: stop.arrival.time.low,
                depart: stop.departure.time.low,
                delay: stop.arrival.delay
            });
        }

        if (stops.length === 0)
            continue;

        const shape = getTripShape(trip, stops.length), line = shapeLineMap.get(shape);

        if (
            !previousStop &&
            !(tripId.length === 3 && stops.length > 1) &&
            stops[0].arrive > time
            /*
            If a 600 range train has both of its stops, don't find a previous one because there isn't one
            https://www.bart.gov/schedules/developers/gtfs-realtime
            "The trip_id values generated by the BART to Antioch system are
            not coordinated with the trip_id values generated by the BART
            schedule system. As a result, GTFS-RT trip_id for
            Pittsburg Center and Antioch stations (in the 600 range) have no
            match in GTFS. Service alerts for the system are still available."
            */
        ) {
            previousStop = getPreviousStop(tripId, shape, stops[0].station, stops[0].delay, time, stops[0].arrive);
            //console.log(tripId, stops[0], previousStop)
        }

        if (stops.length === 1 && (!previousStop || stops[0].arrive <= time))
            // Nowhere to start from
            continue;

        // Only fetch lengths if needed
        if (!trainLengths) {
            trainLengths = await getTrainLengths();
            time = Date.now() / 1000;
        }

        // TODO: if train is leaving, use previousStop
        let length = 8;
        if (tripId.length === 3)
            // 600 series trains (eBART) are always 3 long
            length = 3;
        else {
            // Regular trains use reported length
            let arrivalObject = trainLengths[stops[0].station.substring(0, 3)];
            if (arrivalObject) {
                arrivalObject = arrivalObject[line];
                if (arrivalObject)
                    length = arrivalObject.length;
            }
        }

        const train = new Train(tripId, line, shape, length, points[shape], stops, previousStop, time, messageObject);
        trains.push(train);
    }
}

// Testing purposes
if (process.argv[1].endsWith('gtfs.js')) {
    const trains = [];
    await updateTrains(trains, {
        create: [],
        delete: [],
        move: [],
        station: [],
        update: [],
    });
}
