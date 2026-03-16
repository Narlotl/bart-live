import { get, Agent } from 'https';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { Train } from './Train.js';
import { exit } from 'process';
import unzipper from 'unzipper';

if (!process.env.API_KEY) {
    console.error('No API key!');
    exit(1);
}

const shapes = JSON.parse(readFileSync('shapes.json', 'utf8'));
export const points = JSON.parse(readFileSync('points.json', 'utf8'));

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
    return parseInt(parts[0] * 3600) + parseInt(parts[1] * 60) + parseInt(parts[2]);
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

    if (firstStop.startsWith('C80' /* Pittsburg/Bay Point */) && shape[2] === '1') // Don't add Pittsburg Center to Yellow-S trains from Pittsburg / Bay Point
        return;

    for (let i = 0; i < stopTimes.length; i++) {
        if (stopTimes[i][0] === tripId) {
            if (stopTimes[i][3] === firstStop)
                // Stop is first, so there's nothing before it
                return;

            let stop;
            while (++i < stopTimes.length && (stop = stopTimes[i])[0] === tripId) {
                if (stop[3] === firstStop) {
                    const previous = stopTimes[i - 1];
                    const localTime = time - 8 * 3600;
                    // TODO: use timezone in agency.txt
                    const localDayStart = localTime - (localTime % SECONDS_PER_DAY);
                    return { // GTFS stop structure
                        stopId: previous[3],
                        departure: {
                            time: {
                                low: Math.min(localDayStart + stringTimeToSeconds(previous[2]) + delay + 8 * 3600 /* timezone offset  TODO: use timezene */, time)
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
                        low: time
                    }
                }
            };
};

export const trips = readFileSync('gtfs/trips.txt', 'utf8')
    .split('\r\n').slice(1).map(l => l.split(','));
// route_id,service_id,trip_id,trip_headsign,direction_id,block_id,shape_id,trip_load_information,wheelchair_accessible,bikes_allowed
export const getTripShape = (train, stopCount, startIndex = 0) => {
    let route;
    // Search static GTFS for trip
    if (startIndex === 0) // If this has already been tried on a previous iteratoin, don't try again
        for (let i = 0; i < trips.length; i++) {
            if (trips[i][2] === train.id) {
                if (trips[i][6])
                    return trips[i][6];

                // If there's no shape, pick a shape on the route
                route = trips[i][0].padStart(3, '0');

                break;
            }
        }

    // Make a guess of what shape fits route and stops
    const shapeChoices = shapes.filter(shape => !route /* check all if no route */ || shape.shape.startsWith(route));
    // Track place on each option
    const choiceIndices = {};

    // If the train only has one stop, choose a shape where that stop isn't the beginning
    if (stopCount === 1) {
        const prefix = train.tripUpdate.stopTimeUpdate[0].stopId.substring(0, 3); // Get station prefix
        for (let i = 0; i < shapeChoices.length; i++)
            if (!shapeChoices[i].stops[0].startsWith(prefix) && shapeChoices[i].stops.find(s => s.startsWith(prefix)))
                return shapeChoices[i].shape;
    }

    for (let i = startIndex; i < train.tripUpdate.stopTimeUpdate.length; i++) {
        const stop = train.tripUpdate.stopTimeUpdate[i];
        // Loop label: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/label
        // Loop through each choice and check if stop is found
        choiceLoop: for (let j = 0; j < shapeChoices.length; j++) {
            const choice = shapeChoices[j];

            // Loop through each stop on shape to make sure they are in order
            // Index only increases, so if it doesn't find the next stop, that means the shape isn't in the correct order
            for (let k = choiceIndices[choice.shape] || 0; k < choice.stops.length; k++) {
                if (choice.stops[k] === stop.stopId) {
                    // Stop found, check next shape
                    choiceIndices[choice.shape] = k + 1;
                    continue choiceLoop;
                }
            }

            if (shapeChoices.length === 1)
                // If removal would leave choices empty, the train uses a combination of shapes, so use the best match (last choice left) for the portion it fits
                // After that, call the function again with the other portion of the shape and get combination of shapes
                return [{ shape: shapeChoices[0].shape, stop: train.tripUpdate.stopTimeUpdate[i].stopId }].concat(getTripShape(train, stopCount, i));

            // Remove choices that don't have stops in order
            shapeChoices.splice(j, 1);
            j--;
        }
    }

    if (shapeChoices.length === 0)
        return '001A_shp'
    if (stopCount > 1)
        return shapeChoices[0].shape;

    // If the train only has one stop, choose a shape where that stop isn't the beginning
    const prefix = train.tripUpdate.stopTimeUpdate[0].stopId.substring(0, 3); // get station prefix
    for (let i = 0; i < shapeChoices.length; i++)
        if (!shapeChoices[i].stops[0].startsWith(prefix))
            return shapeChoices[i].shape;
    return shapeChoices[0].shape;
};

export const routes = readFileSync('gtfs/routes.txt', 'utf8')
    .split('\r\n').slice(1).map(l => l.split(','))
    .reverse(); // start with longest routes first
// route_id,route_short_name,route_long_name,route_desc,route_type,route_url,route_color,route_text_color

export const shapeLineMap = new Map(
    shapes.map(
        shape => [
            shape.shape,
            routes.find(
                route => shape.shape.includes(route[0]) // find route that matches shape name
            )[1] // return line name of route
        ]
    )
);

// Fetch implementation using native HTTPS module
const fetch = (url, agent) => new Promise((resolve, reject) => {
    get(url, { agent }, res => {
        if (res.statusCode < 300)
            resolve(res);
        // Error if status isn't OK
        reject(res.statusCode);
    }).on('error', reject).end();
});

const etdUrl = 'https://api.bart.gov/api/etd.aspx?cmd=etd&orig=ALL&json=y&key=' + process.env.API_KEY;
export const updateTrains = async (trains, messageObject) => {
    // Create persistent connection agent
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });

    let buf, feed, etds;
    try {
        // Fetch GTFS-RT feed
        buf = await fetch('https://api.bart.gov/gtfsrt/tripupdate.aspx', agent)
            .then(res => new Promise(resolve => {
                // Read all bytes of chunked stream
                let buf = Buffer.alloc(0), read;
                res.on('readable', () => {
                    while ((read = res.read()) !== null)
                        buf = Buffer.concat([buf, read]);
                });
                res.on('end', () => resolve(buf));
            })
            );

        //const buf = new Uint8Array(readFileSync('tripupdate.aspx')); // Testing purposes
        // Create GTFS-RT feed object
        feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buf);
    }
    catch (e) {
        // Don't crash on network error
        agent.destroy();
        console.error('Error fetching tripupdate:', e);
        return;
    }

    try {
        // Fetch train length data
        etds = await fetch(etdUrl, agent).then(res => new Promise(resolve => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(JSON.parse(data).root.station))
        }));
    }
    catch (e) {
        // Don't crash on network error
        agent.destroy();
        console.error('Error fetching train lengths:', e);
        return;
    }

    // Close persistent connection
    agent.destroy();

    // Create map of lengths of trains departing from each station
    // Maps station to list of lines, which have the length for the train on them
    const trainLengths = {};
    const departures = [];
    for (const station of etds) {
        const lines = {};
        const stationDepartures = [station.abbr];
        for (const destination of station.etd) {
            let destDepartures = destination.destination + ': ';
            for (let i = 0; i < destination.estimate.length; i++) {
                const line = destination.estimate[i];

                if (i > 0)
                    destDepartures += ', ';
                destDepartures += line.minutes;
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
            stationDepartures.push(destDepartures);
        }
        departures.push(stationDepartures.join('|'));
        trainLengths[abbreviationToId(station.abbr)] = lines;
    }
    messageObject.departures = departures;

    const time = Date.now() / 1000;

    trainLoop: for (let i = 0; i < feed.entity.length; i++) {
        const trip = feed.entity[i];
        const tripId = trip.tripUpdate.trip.tripId;

        for (let j = 0; j < trains.length; j++) {
            if (trains[j].tripId === tripId) {
                // Matching train found
                const train = trains[j], updates = trip.tripUpdate.stopTimeUpdate;

                const stopsToRemove = [];

                for (const update of updates) {
                    if (train.nextStation === undefined)
                        break;

                    if (update.stopId === train.nextStation.station) {
                        // Update nextStation
                        if (update.arrival.time.low <= time) { // If the nextStation has passed, update to the new nextStation
                            train.advanceStation(time);
                            train.departTime = time; // Don't stop if passed
                        }
                        else
                            train.updateStop(-1, update, time);
                        continue;
                    }

                    // Update future stops
                    for (let k = 0; k < train.stops.kength; l++) {
                        if (train.stops[k].station === update.stopId) {
                            train.updateStop(k, update);
                            break;
                        }

                        // If a stop wasn't matched, remove it
                        stopsToRemove.push(k);
                    }
                }

                for (let k = 0; k < stopsToRemove.length; k++)
                    train.stops.splice(stopsToRemove[k] - k /* shift index down to account for previous deletions */, 1);

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

        try {
            const shape = getTripShape(trip, stops.length), shapeName = typeof shape === 'object' ? shape[0].shape : shape; // Use first element if list of shapes
            const line = shapeLineMap.get(shapeName);

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
            )
                previousStop = getPreviousStop(tripId, shapeName, stops[0].station, stops[0].delay, time, stops[0].arrive);

            if (stops.length === 1 && (!previousStop || stops[0].arrive <= time))
                // Nowhere to start from
                continue;

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

            const train = new Train(tripId, line, shape, length, points[shapeName], stops, previousStop, time, messageObject);
            trains.push(train);
        }
        catch (e) {
            console.error(tripId, e);
            writeFileSync('tripupdate.aspx', buf);
            exit(1);
        }
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
    console.log(trains)
}
