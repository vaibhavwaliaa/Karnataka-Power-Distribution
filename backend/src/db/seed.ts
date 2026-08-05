import { db } from "./connection";
import {
  poles,
  transformers,
  poleState,
  scheduledOutages,
  tickets,
  ticketAffectedPoles,
  telemetry,
} from "./schema";
import { sql } from "drizzle-orm";

/* -------------------------------------------------------------------------- */
/*  Constants matching the assignment spec proportions                         */
/* -------------------------------------------------------------------------- */

const NUM_SUBSTATIONS = 4;
const NUM_FEEDERS = 31;
const NUM_DTS = 80; // Enough to exercise the algorithm, not all 412
const POLES_PER_DT_MIN = 9;
const POLES_PER_DT_MAX = 120;
const POLES_PER_DT_MEDIAN = 50;
const NO_DEVICE_FRACTION = 0.09;
const NO_TOPOLOGY_FRACTION = 0.60;
const NO_PINCODE_FRACTION = 0.03;

// Bangalore-area coordinates for realistic GPS data
const BASE_LAT = 12.95;
const BASE_LON = 77.56;
const SPREAD_LAT = 0.06; // ~6.6 km
const SPREAD_LON = 0.08; // ~8.8 km

// Pole spacing: ~30-50m typical on an LT line
const POLE_SPACING_DEG = 0.0004; // ~44m at this latitude

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function rand(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

function randInt(min: number, max: number): number {
  return Math.floor(rand(min, max + 1));
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Generate a roughly log-normal pole count to get the right median/spread.
 */
function samplePoleCount(): number {
  // log-normal with median ~50, range ~9-120
  const mu = Math.log(POLES_PER_DT_MEDIAN);
  const sigma = 0.5;
  let val: number;
  // Box-Muller for normal distribution
  const u1 = Math.random();
  const u2 = Math.random();
  const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  val = Math.round(Math.exp(mu + sigma * normal));
  return Math.max(POLES_PER_DT_MIN, Math.min(POLES_PER_DT_MAX, val));
}

const POLE_TYPES = [
  "LT-9m-PCC",
  "LT-9m-PCC",
  "LT-9m-PCC", // most common
  "LT-8m-Steel",
  "LT-8m-Steel",
  "LT-11m-PCC",
  "LT-9m-RCC",
];

const WARDS = Array.from({ length: 40 }, (_, i) =>
  `W-${String(i + 60).padStart(3, "0")}`
);

const PINCODES = [
  "560078", "560034", "560003", "560011", "560041",
  "560050", "560070", "560085", "560095", "560100",
];

/* -------------------------------------------------------------------------- */
/*  Generator                                                                  */
/* -------------------------------------------------------------------------- */

interface GeneratedDT {
  dtId: string;
  feederId: string;
  lat: number;
  lon: number;
  capacityKva: number;
  householdsServed: number;
}

interface GeneratedPole {
  poleId: string;
  lat: number;
  lon: number;
  feederId: string;
  dtId: string;
  seqOnLine: number | null;
  parentPoleId: string | null;
  poleType: string;
  ward: string;
  pincode: string | null;
  deviceId: string | null;
  topologySource: "surveyed" | "inferred";
}

function generateNetwork() {
  const dtList: GeneratedDT[] = [];
  const poleList: GeneratedPole[] = [];

  // Assign feeders to substations
  const feeders: string[] = [];
  for (let i = 1; i <= NUM_FEEDERS; i++) {
    const substation = Math.ceil(i / (NUM_FEEDERS / NUM_SUBSTATIONS));
    feeders.push(`F-${String(substation).padStart(2, "0")}-${String(i).padStart(2, "0")}`);
  }

  let poleCounter = 1;

  for (let dtIdx = 0; dtIdx < NUM_DTS; dtIdx++) {
    const dtId = `D-${String(dtIdx + 1).padStart(4, "0")}`;
    const feederId = feeders[dtIdx % feeders.length];
    const dtLat = BASE_LAT + rand(0, SPREAD_LAT);
    const dtLon = BASE_LON + rand(0, SPREAD_LON);
    const capacityKva = pick([100, 200, 250, 315, 500]);
    const numPoles = samplePoleCount();
    const householdsServed = Math.round(numPoles * rand(3, 6));

    // Decide if this DT has surveyed topology (40%) or not (60%)
    const hasSurveyedTopology = Math.random() > NO_TOPOLOGY_FRACTION;

    dtList.push({
      dtId,
      feederId,
      lat: dtLat,
      lon: dtLon,
      capacityKva,
      householdsServed,
    });

    // Generate a radial tree of poles
    // Main trunk: ~60-80% of poles
    // 1-3 branches off the trunk
    const trunkLen = Math.round(numPoles * rand(0.6, 0.8));
    const remainingPoles = numPoles - trunkLen;

    // Direction from DT (random angle)
    const mainAngle = rand(0, 2 * Math.PI);
    const angleDelta = rand(-0.3, 0.3); // slight curve

    const dtPoles: GeneratedPole[] = [];

    // Generate trunk poles
    let prevPoleId: string | null = null;
    for (let i = 0; i < trunkLen; i++) {
      const poleId = `P-${String(poleCounter++).padStart(6, "0")}`;
      const angle = mainAngle + angleDelta * (i / trunkLen);
      const distance = (i + 1) * POLE_SPACING_DEG;
      const lat = dtLat + distance * Math.cos(angle) + rand(-0.00005, 0.00005);
      const lon = dtLon + distance * Math.sin(angle) + rand(-0.00005, 0.00005);

      const hasDevice = Math.random() > NO_DEVICE_FRACTION;
      const hasPincode = Math.random() > NO_PINCODE_FRACTION;

      // Device ID format: KSPDB-SD{sub}-{dt}-{pole_num}
      const subNum = feederId.split("-")[1];
      const deviceId = hasDevice
        ? `KSPDB-SD${subNum}-${dtId}-${poleId.slice(2)}`
        : null;

      const pole: GeneratedPole = {
        poleId,
        lat,
        lon,
        feederId,
        dtId,
        seqOnLine: hasSurveyedTopology ? i + 1 : null,
        parentPoleId: hasSurveyedTopology ? (prevPoleId || dtId) : null,
        poleType: pick(POLE_TYPES),
        ward: pick(WARDS),
        pincode: hasPincode ? pick(PINCODES) : null,
        deviceId,
        topologySource: hasSurveyedTopology ? "surveyed" : "inferred",
      };

      dtPoles.push(pole);
      prevPoleId = poleId;
    }

    // Generate branch poles (spurs off the trunk)
    if (remainingPoles > 0) {
      const numBranches = randInt(1, Math.min(3, Math.floor(remainingPoles / 3) || 1));
      let polesLeft = remainingPoles;

      for (let b = 0; b < numBranches && polesLeft > 0; b++) {
        const branchLen =
          b === numBranches - 1
            ? polesLeft
            : randInt(2, Math.min(10, polesLeft));
        polesLeft -= branchLen;

        // Branch off a random point on the trunk (not the first few)
        const branchPointIdx = randInt(
          Math.floor(trunkLen * 0.2),
          trunkLen - 1
        );
        const branchParent = dtPoles[branchPointIdx];
        const branchAngle = mainAngle + rand(0.5, 2.0) * (Math.random() > 0.5 ? 1 : -1);

        let branchPrevId = branchParent.poleId;
        for (let j = 0; j < branchLen; j++) {
          const poleId = `P-${String(poleCounter++).padStart(6, "0")}`;
          const distance = (j + 1) * POLE_SPACING_DEG;
          const lat =
            branchParent.lat +
            distance * Math.cos(branchAngle) +
            rand(-0.00005, 0.00005);
          const lon =
            branchParent.lon +
            distance * Math.sin(branchAngle) +
            rand(-0.00005, 0.00005);

          const hasDevice = Math.random() > NO_DEVICE_FRACTION;
          const hasPincode = Math.random() > NO_PINCODE_FRACTION;

          const subNum = feederId.split("-")[1];
          const deviceId = hasDevice
            ? `KSPDB-SD${subNum}-${dtId}-${poleId.slice(2)}`
            : null;

          const pole: GeneratedPole = {
            poleId,
            lat,
            lon,
            feederId,
            dtId,
            seqOnLine: hasSurveyedTopology ? trunkLen + j + 1 : null,
            parentPoleId: hasSurveyedTopology ? branchPrevId : null,
            poleType: pick(POLE_TYPES),
            ward: pick(WARDS),
            pincode: hasPincode ? pick(PINCODES) : null,
            deviceId,
            topologySource: hasSurveyedTopology ? "surveyed" : "inferred",
          };

          dtPoles.push(pole);
          branchPrevId = poleId;
        }
      }
    }

    poleList.push(...dtPoles);
  }

  return { dtList, poleList, feeders };
}

/* -------------------------------------------------------------------------- */
/*  Seed function                                                              */
/* -------------------------------------------------------------------------- */

export async function seed() {
  // Check if data already exists
  const existingPoles = await db.select({ count: sql<number>`count(*)` }).from(poles);
  if (existingPoles[0].count > 0) {
    console.log(`Database already seeded (${existingPoles[0].count} poles). Skipping.`);
    return;
  }

  console.log("Generating synthetic network...");
  const { dtList, poleList } = generateNetwork();

  console.log(
    `Generated ${dtList.length} transformers, ${poleList.length} poles`
  );

  // Count topology stats
  const withTopology = poleList.filter((p) => p.seqOnLine !== null).length;
  const withDevices = poleList.filter((p) => p.deviceId !== null).length;
  const withPincode = poleList.filter((p) => p.pincode !== null).length;
  console.log(
    `  Topology known: ${withTopology}/${poleList.length} (${Math.round((withTopology / poleList.length) * 100)}%)`
  );
  console.log(
    `  With devices: ${withDevices}/${poleList.length} (${Math.round((withDevices / poleList.length) * 100)}%)`
  );
  console.log(
    `  With pincode: ${withPincode}/${poleList.length} (${Math.round((withPincode / poleList.length) * 100)}%)`
  );

  // Insert transformers
  console.log("Inserting transformers...");
  await db.insert(transformers).values(dtList);

  // Insert poles in batches (Postgres has a parameter limit)
  console.log("Inserting poles...");
  const BATCH_SIZE = 500;
  for (let i = 0; i < poleList.length; i += BATCH_SIZE) {
    const batch = poleList.slice(i, i + BATCH_SIZE);
    await db.insert(poles).values(batch);
  }

  // Initialize pole_state for all poles with devices
  console.log("Initializing pole state...");
  const stateRecords = poleList.map((p) => ({
    poleId: p.poleId,
    currentStatus: "live" as const, // Start all poles as live
    lastEventType: "heartbeat" as const,
    lastEventTs: new Date(),
    lastHeartbeatTs: new Date(),
    lastSeq: 0,
    updatedAt: new Date(),
  }));

  for (let i = 0; i < stateRecords.length; i += BATCH_SIZE) {
    const batch = stateRecords.slice(i, i + BATCH_SIZE);
    await db.insert(poleState).values(batch);
  }

  // Add a couple of sample scheduled outages
  console.log("Inserting sample scheduled outages...");
  const now = new Date();
  const twoHoursLater = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  const fourHoursLater = new Date(now.getTime() + 4 * 60 * 60 * 1000);
  const fiveHoursLater = new Date(now.getTime() + 5 * 60 * 60 * 1000);

  await db.insert(scheduledOutages).values([
    {
      id: `SO-${now.toISOString().slice(0, 10)}-001`,
      scope: "feeder",
      targetId: dtList[0].feederId,
      start: twoHoursLater,
      end: fourHoursLater,
      reason: "Planned maintenance - jumper replacement",
    },
    {
      id: `SO-${now.toISOString().slice(0, 10)}-002`,
      scope: "dt",
      targetId: dtList[5]?.dtId || dtList[0].dtId,
      start: fourHoursLater,
      end: fiveHoursLater,
      reason: "Load shedding",
    },
  ]);

  console.log("Seed complete!");
  console.log(`  ${dtList.length} transformers`);
  console.log(`  ${poleList.length} poles`);
  console.log(`  ${stateRecords.length} pole state records`);
  console.log(`  2 sample scheduled outages`);
}

/* -------------------------------------------------------------------------- */
/*  Standalone execution                                                       */
/* -------------------------------------------------------------------------- */

// When run directly: seed and exit
if (require.main === module) {
  seed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Seed failed:", err);
      process.exit(1);
    });
}
