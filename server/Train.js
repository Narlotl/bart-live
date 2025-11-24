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
                    const distanceToSkip = // Distance travelled past previous stop
                        totalDistance *
                        (time - previousStop.departure.time.low) / (this.nextStation.arrive - previousStop.departure.time.low); // Percent of time passed
                    let distanceSkipped = 0;
                    let skipDistance;
                    while (distanceSkipped + (skipDistance = points[this.index][2]) < distanceToSkip) {
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

                    this.speed = (totalDistance - distanceToSkip) // Distance between current location and stop
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

    step(distance) {
        if (this.nextStation === undefined || this.index === this.points.length)
            return ['delete', this.tripId];

        let point = this.points[this.index];
        if (point.length === 5 && point[4] === this.nextStation.station) {
            // Arrived at station
            const trainDone = this.advanceStation(this.nextStation.depart);
            if (trainDone)
                // If the train has no stops left, end without sending station message
                return trainDone;

            return ['station', this.tripId + ',' + this.line + ',' + idToStation(this.nextStation.station) + ',' + this.nextStation.arrive + ',' + this.speed];
        }

        if (distance >= this.distanceToNext) {
            // Move to next segment
            distance -= this.distanceToNext;
            this.index++;

            point = this.points[this.index];
            this.lat = point[0];
            this.lon = point[1];
            this.distanceToNext = point[2];
            this.direction = point[3];

            return this.step(distance);
        }

        // Move along portion of segment
        const stepPoint = geod.Direct(this.lat, this.lon, this.direction, distance, outmask);
        this.lat = stepPoint.lat2, this.lon = stepPoint.lon2;
        this.distanceToNext -= distance;

        return ['move', this.tripId + ',' + this.lat + ',' + this.lon];
    }

    move(time, timeStep, timeSpeed = 1) {
        if (time < this.departTime) // Only move train if it has left station
            return;

        // Calculate new position
        return this.step(this.speed * timeStep * timeSpeed);
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

        this.speed = this.distanceToNextStop() / (this.nextStation.arrive - startTime); // m/s
        if (isNaN(this.speed)) {
            // Delete NaN speed trains
            console.log(this, this.distanceToNextStop());
            this.speed = 0;
            this.messageObject.delete.push(this.tripId);
            return;
        }
        this.messageObject.update.push(this.tripId + ',' + this.line + ',' + idToStation(this.nextStation.station) + ',' + this.nextStation.arrive + ',' + this.speed);
    }

    advanceStation(time) {
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
