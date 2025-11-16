import { createServer } from 'http';
import { idToStation, updateTrains } from './gtfs.js';
import { createInterface } from 'node:readline';

const sleep = ms => new Promise((resolve, reject) => setTimeout(resolve, ms));

let time = Date.now() / 1000, updateTime = time;
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
const timeStep = 0.100; // seconds

const connections = [];

createServer(async (req, res) => {
    console.log('connection');

    // Initialize server-sent events
    // https://www.smashingmagazine.com/2018/02/sse-websockets-data-flow-http2/#sample-server-implementation
    // https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
    });

    const index = connections.length; // this connection's place in array
    connections.push(res);

    // Send all current trains to connection
    let creationMessages = 'event: create\ndata: ';
    for (const train of trains) {
        if (!train.nextStation) {
            console.log(train)
            continue;
        }
        creationMessages += train.tripId + ',' + train.line + ',' + idToStation(train.nextStation.station) + ',' + train.nextStation.arrive + ',' + train.speed + ',' + train.shape + ',' + train.length + ';';
    }
    res.write(creationMessages + '\n\n');

    res.on('close', () => {
        console.log('disconnection');

        connections.splice(index, 1);

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
};
let nextStepTime = Date.now() / 1000 + timeStep;

// Simulation loop
while (true) {
    // Step through time

    // Update trains every 30 seconds
    if (time >= updateTime) {
        updateTrains(trains, messages);
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

        message += 'event: ' + event + '\n';
        message += 'data: ' + messages[event].join(';') + '\n\n';

        messages[event] = [];
    }
    message += 'event: time\ndata: ' + Math.floor(time) + '\n\n';

    // Send events to all connections
    for (const con of connections)
        con.write(message)

    await sleep(nextStepTime * 1000 - Date.now()); // Amount of milliseconds until timeStep after the previous step
    time += timeStep * timeSpeed;
    nextStepTime += timeStep;
}
