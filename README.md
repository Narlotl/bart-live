# bart-simulation
<img src="https://bart.eliasfretwell.com/assets/icon.png">

A real-time simulation of Bay Area Rapid Transit trains.


Since BART doesn't publish GPS data, this is an estimate of where trains are in real time. It uses the [GTFS-RT](https://gtfs.org/documentation/overview/#gtfs-realtime) feed to calculate the average speed between stops. From there, the train moves along the actual path, defined by [shapes.txt](https://gtfs.org/documentation/schedule/reference/#shapestxt) in the [static GTFS](https://gtfs.org/documentation/overview/#gtfs-schedule).

## Running
[Register for a BART API key](https://api.bart.gov/api/register.aspx) or [use the public one](https://www.bart.gov/schedules/developers/api).

### Server

- For the first time you run the server, run `npm install` to get dependencies.
- Set the `API_KEY` environment variable to your API key and the `CERT` and `PRIV_KEY` variables to the paths of the respective certificate files.
- Run `node server.js`

### Client

- Run `npx live-server` (requires [live-server](https://www.npmjs.com/package/live-server))

## Data

- [GTFS static files](https://www.bart.gov/schedules/developers/gtfs)
- [GTFS-RT](https://www.bart.gov/schedules/developers/gtfs-realtime)
- [Train lengths](https://api.bart.gov/docs/etd/etd.aspx)
- The shape data used by the program is based on the [shapes.txt](https://gtfs.org/documentation/schedule/reference/#shapestxt) GTFS file. Points for the stations have been added along each path. The [QGIS](https://qgis.org/) project is in the [gis directory](https://github.com/Narlotl/bart-simulation/tree/main/gis).
