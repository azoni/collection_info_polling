const Web3 = require('web3');
const opensea = require('opensea-js');
const throttledQueue = require('throttled-queue');
const data = require('./data.json');
const { MongoClient } = require("mongodb");
// Connection URI
const uri = "mongodb://10.0.0.80:27017/";
// Create a new MongoClient
const client = new MongoClient(uri);
let WATCH_LIST_FROM_MONGO = [];

console.log('App loaded.');

const OpenSeaPort = opensea.OpenSeaPort;
const Network = opensea.Network;
const provider = new Web3.providers.HttpProvider('https://mainnet.infura.io');
let floorDict = {};
let seaport = new OpenSeaPort(provider, {
  networkName: Network.Main,
});

const ONE_SEC = 2000;
const floorThrottle = throttledQueue(2, ONE_SEC);
/**
 * Gets cached seaport or creates the first instance of it and returns it. Creates providerEngine if seaport wasnt cached too.
 * Meant to save us the issue of having a seaport and provider engine running if we don't need to.
 *
 * @returns {opensea.OpenSeaPort} seaport instance
 */
function getSeaport() {
  return seaport;
}

async function main() {
  await client.connect();

  updateLoop();
}

async function updateLoop() {
  let myWatchList = [];
  try {
    const doc_cursor = client.db("test").collection("watch_lists").find();
    myWatchList = (await doc_cursor.toArray()).map(({slug}) => slug);
  } catch (error) {
    console.error(error);
    console.error(`Will default to watchlist in data file`);
    myWatchList = data.WATCH_LIST;
  }

  let s = Date.now();
  await updateFloorDictionary(myWatchList);
  let e = Date.now();
  console.log(`update all floors took ${e - s}ms`);
  setTimeout(updateLoop, 2500);
}

async function updateFloorDictionary(watch_list) {

  //data.WATCH_LIST
  return Promise.all(
    watch_list.map((curr_coll_name) =>
      floorThrottle(() => specialUpdateSingleFloor(curr_coll_name, 2))
    )
  );
}
let response_error_count = 0;
async function specialUpdateSingleFloor(collection, retry = 0) {
  response_error_count = Math.max(response_error_count - 1, 0);
  if (response_error_count >= 3) {
    await floorThrottle(() => specialUpdateSingleFloor(collection, retry));
  }
  let warningTimeout;
  try {
    let fiveSecCount = 0;
    const WARN_TIME = 5000;
    function hangingWarning() {
      console.log(`fetching ${collection} details taking too long. time so far: ${++fiveSecCount * WARN_TIME}ms`);
      warningTimeout = setTimeout(hangingWarning, WARN_TIME);
    }
    warningTimeout = setTimeout(hangingWarning, WARN_TIME);
    
    const collect = await getSeaport().api.get('/api/v1/collection/' + collection);
    clearTimeout(warningTimeout);
    const fetched_floor = collect['collection']['stats']['floor_price'];
    const stats = {
      ...(collect['collection']['stats']),
      dev_seller_fee_basis_points: collect['collection']['dev_seller_fee_basis_points']
    };
    if (fetched_floor > (floorDict[collection]?.floor) * 1.3) {
      console.warn(`potential bug floor with: ${collection}. old floor: ${floorDict[collection]?.floor}, new floor: ${fetched_floor}`);
      return;
    }
    floorDict[collection] = {
      floor: fetched_floor,
    };
    fetch('http://10.0.0.59:3000/floor', {
      method: 'POST',
      body: JSON.stringify({
        collection: collection,
        floor: fetched_floor,
        stats: stats,
      })
    })
      .catch((ex) => console.log(ex))
    console.log(`floor updated: ${collection}, floor: ${fetched_floor}`);
  } catch (ex) {
    clearTimeout(warningTimeout);
    response_error_count++;
    console.error(ex, '\n', collection)
    if (retry > 0) {
      await floorThrottle(() => specialUpdateSingleFloor(collection, retry - 1))
    }
  }
}

main();
