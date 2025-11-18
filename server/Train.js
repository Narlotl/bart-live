import { idToStation } from './gtfs.js';

import geodesic from 'geographiclib-geodesic';
const Geodesic = geodesic.Geodesic;
const geod = Geodesic.WGS84;
const outmask = Geodesic.LATITUDE | Geodesic.LONGITUDE;

export class Train {
    constructor(tripId, line, shape, length = 8, points, stops, previousStop, time, messageObject) {
        this.tripId = tripId;
        this.line = line;
        this.shape = shape;
        this.length = length;
        this.points = points;
        this.stops = stops;
        this.departTime = previousStop ? previousStop.departure.time.low : stops[0].depart;
        this.nextStation = stops[0];
        this.distanceToNext = 0;
        this.timeToMakeUp = 0;
        this.messageObject = messageObject;

        // Start train at its first stop
        let searchStop = previousStop ? previousStop.stopId : this.nextStation.station;
        let searchForPrevious = previousStop;
        for (let i = 0; i < points.length; i++) {
            if (points[i].length === 5 && points[i][4] === searchStop) {
                if (searchForPrevious) {
                    this.index = i;
                    const totalDistance = this.distanceToNextStop();
                    const distanceToSkip = // distance travelled past previous stop
                        totalDistance *
                        (time - previousStop.departure.time.low) / (this.nextStation.arrive - previousStop.departure.time.low); // Percent of time passed
                    let distanceSkipped = 0;
                    let skipDistance;
                    while (distanceSkipped + (skipDistance = points[this.index + 1][2]) < distanceToSkip) {
                        distanceSkipped += skipDistance;
                        this.index++;
                    }
                    // Closest point to position
                    const point = points[this.index];
                    this.lat = point[0];
                    this.lon = point[1];
                    this.direction = point[3];

                    const pointSkipDistance = distanceToSkip - distanceSkipped;
                    const finalPoint = geod.Direct(this.lat, this.lon, this.direction, pointSkipDistance, outmask);
                    this.lat = finalPoint.lat2, this.lon = finalPoint.lon2;
                    this.distanceToNext = point[2] - pointSkipDistance;

                    this.speed = (totalDistance - distanceToSkip /* distance between current location and stop */)
                        / (this.nextStation.arrive - time);

                    searchStop = this.nextStation.station;
                    searchForPrevious = false;
                    break;
                }

                this.index = i;
                break;
            }
        }

        messageObject.create.push(tripId + ',' + line + ',' + idToStation(this.nextStation.station) + ',' + this.nextStation.arrive + ',' + this.speed + ',' + shape + ',' + length);
    }

    move(time, timeStep, timeSpeed = 1) {
        if (time < this.departTime) // Only move train if it has left station
            return;

        if (this.distanceToNext === 0) { // Move to next point on segment
            if (this.nextStation === undefined || this.index === this.points.length)
                return ['delete', this.tripId];

            const point = this.points[this.index];
            this.lat = point[0];
            this.lon = point[1];
            this.distanceToNext = point[2];
            this.direction = point[3];

            if (point.length === 5 && point[4] === this.nextStation.station) {
                // Arrived at station

                const trainDone = this.advanceStation();
                if (trainDone)
                    // If the train has no stops left, end without sending station message
                    return trainDone;

                return ['station', this.tripId + ',' + this.line + ',' + idToStation(this.nextStation.station) + ',' + this.nextStation.arrive + ',' + this.speed];
            }

            this.index++;
        }

        // Calculate new position
        let stepDistance = this.speed * (timeStep * timeSpeed + this.timeToMakeUp);
        this.timeToMakeUp = 0; // reset after it is accounted for
        if (stepDistance > this.distanceToNext) { // Don't go past the end of the segment
            // If the train should have gone further than the clamped distance, keep track of how much time was lost so it can be made up at the next segment
            this.timeToMakeUp = (stepDistance - this.distanceToNext) / this.speed;
            stepDistance = this.distanceToNext;
        }
        const stepPoint = geod.Direct(this.lat, this.lon, this.direction, stepDistance, outmask);
        this.lat = stepPoint.lat2, this.lon = stepPoint.lon2;
        this.distanceToNext -= stepDistance;

        return ['move', this.tripId + ',' + this.lat + ',' + this.lon];
    }

    distanceToNextStop() {
        if (this.nextStation === undefined)
            // Train is at end
            return 0;

        let distance = this.distanceToNext - this.points[this.index][2];
        for (let i = this.index; i < this.points.length; i++) {
            const point = this.points[i];

            if (point.length === 5 && point[4] === this.nextStation.station) // End of segment
                return distance;

            distance += point[2];
        }
    }

    getPreviousStation() {
        for (let i = this.index - 1; i >= 0; i--)
            if (this.points[i].length === 5)
                return this.points[i][4];
    }

    calculateSpeed(startTime) {
        if (!this.nextStation)
            return;

        const distance = this.distanceToNextStop()
        this.speed = distance / (this.nextStation.arrive - startTime); // m/s
        this.messageObject.update.push(this.tripId + ',' + this.line + ',' + idToStation(this.nextStation.station) + ',' + this.nextStation.arrive + ',' + this.speed);
    }

    advanceStation(time = this.departTime) {
        const station = this.stops.shift();

        if (this.stops.length === 0) { // End of line
            this.nextStation = undefined;
            this.distanceToNext = 0;
            return ['move', this.tripId + ',' + this.lat + ',' + this.lon];
        }

        this.nextStation = this.stops[0];
        this.departTime = station.depart;

        this.calculateSpeed(time);
    }
}
