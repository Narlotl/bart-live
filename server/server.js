import { createServer as createServerHTTPS } from 'https';
import { createServer as createServerHTTP } from 'http';
import { idToStation, updateTrains } from './gtfs.js';
import { createInterface } from 'node:readline';
import { existsSync, readFileSync } from 'fs';
import { createGzip } from 'node:zlib';

const sleep = ms => new Promise((resolve, reject) => setTimeout(resolve, ms));

let time = Date.now() / 1000;
// Start at nearest whole second because all train times are on seconds
await sleep((Math.ceil(time) - time) * 1000);
time = Math.ceil(time);
let updateTime, updating = true, trainDeleted = false;
const trains = [];

// Print train list when enter pressed
const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
});

const waitForEnter = () =>
    rl.question('', () => {
        console.log(trains);
        waitForEnter();
    });
waitForEnter();

const timeSpeed = 1;
let timeStep = 1.000; // seconds

const setTimeStep = () => {
    if (trains.length === 0)
        timeStep = 60.000; // Only update every minute when there are no trains
    else if (connectionStreams.length === 0)
        timeStep = 1.000; // Slow server when no connections
    else
        timeStep = 0.100; // Normal speed when there are trains and connections
}

const connectionStreams = [];

let createServer, options;
if (!(process.env.CERT && process.env.PRIV_KEY && existsSync(process.env.CERT) && existsSync(process.env.PRIV_KEY))) {
    console.error('Certificate files not found, using HTTP');
    createServer = createServerHTTP;
    options = {};
}
else {
    createServer = createServerHTTPS;
    options = {
        key: readFileSync(process.env.PRIV_KEY),
        cert: readFileSync(process.env.CERT)
    };
}
createServer(options, async (req, res) => {
    console.log('connection');

    // Initialize server-sent events
    // https://www.smashingmagazine.com/2018/02/sse-websockets-data-flow-http2/#sample-server-implementation
    // https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Content-Encoding': 'gzip',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Vary': 'Origin',
        'Access-Control-Allow-Origin': process.env.ENV === 'prod' ? 'https://bart.eliasfretwell.com' : '*'
    });

    const compression = createGzip();
    compression.pipe(res);
    compression.index = connectionStreams.length; // This connection's place in array
    connectionStreams.push(compression);

    setTimeStep();

    // Send all current trains to connection
    let creationMessages = 'event: create\ndata: ';
    for (const train of trains)
        if (train.nextStation)
            creationMessages += train.tripId + ',' + train.line + ',' + idToStation(train.nextStation.station) + ',' + train.nextStation.arrive + ',' + train.speed + ',' + train.shape + ',' + train.length + ';';
    compression.write(creationMessages + '\n\n');
    compression.flush();

    res.on('close', () => {
        console.log('disconnection');

        connectionStreams.splice(compression.index, 1);
        // Shift all following connections' indices down
        for (let i = compression.index; i < connectionStreams.length; i++)
            connectionStreams[i].index--;
        console.log(connectionStreams)

        setTimeStep();

        res.end();
    });
}).listen(3000);
console.log('server started on 3000')

const messages = {
    create: [],
    delete: [],
    move: [],
    station: [],
    update: [],
    departures: []
};
let nextStepTime = Date.now() / 1000 + timeStep;

updateTrains(trains, messages).then(() => {
    updateTime = time + 30 * timeSpeed;
    setTimeStep();
    updating = false;
});

// Simulation loop
while (true) {
    // Step through time

    // Update trains every 30 seconds
    if (time >= updateTime && !updating) {
        if (connectionStreams.length > 0 || trainDeleted) {
            updating = true; // Since update is non-blocking, don't update if it's running
            trainDeleted = false; // Reset deleted tracker
            updateTrains(trains, messages).then(() => {
                updateTime += 30 * timeSpeed;
                setTimeStep();
                updating = false;
            });
        }
        else
            updateTime += 30 * timeSpeed;
    }

    for (let i = 0; i < trains.length; i++) {
        const event = trains[i].move(time, timeStep, timeSpeed);
        if (event) {
            messages[event[0]].push(event[1]);

            if (event[0] === 'delete')
                trains.splice(
                    trains.findIndex(t => t.tripId === event[1]),
                    1
                );
        }
    }

    // Consolidate all events into one message
    // Each object in data is separated by a semicolon
    let message = '';
    for (const event in messages) {
        if (messages[event].length === 0)
            continue;

        // Track if a train was deleted so GTFS can be updated if there aren't any clients
        if (!trainDeleted && event === 'delete')
            trainDeleted = true;

        message += 'event: ' + event + '\n';
        message += 'data: ' + messages[event].join(';') + '\n\n';

        messages[event] = [];
    }
    message += 'event: time\ndata: ' + Math.floor(time) + '\n\n';

    // Send message to all connections
    for (const compression of connectionStreams) {
        compression.write(message);
        compression.flush();
    }

    await sleep(nextStepTime * 1000 - Date.now()); // Amount of milliseconds until timeStep after the previous step
    time += timeStep * timeSpeed;
    nextStepTime += timeStep;
}
