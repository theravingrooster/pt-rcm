import { createDatabase } from "./index.js";
import { seedSyntheticData } from "./seed-database.js";

const { db, client } = createDatabase(process.env.DATABASE_URL ?? "postgres://pt:pt@localhost:5432/pt_rcm");
try {
  await seedSyntheticData(db);
  console.log("Synthetic seed complete: 1 org, 1 facility, 2 rendering providers, 2 payers; no patients.");
} finally {
  await client.end();
}
