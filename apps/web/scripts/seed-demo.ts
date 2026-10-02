import { readFile } from "node:fs/promises";
import { EncounterIngestSchema } from "@pt-rcm/domain";

const fixture = JSON.parse(await readFile(new URL("../../../fixtures/encounters/shoulder-23min.json", import.meta.url), "utf8"));
const body = EncounterIngestSchema.parse(fixture);
const response = await fetch(process.env.ENCOUNTER_API_URL ?? "http://localhost:3000/api/encounters", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
if (!response.ok) throw new Error(`Demo ingest failed (${response.status}): ${await response.text()}`);
console.log("Synthetic demo encounter ingested:", await response.json());
