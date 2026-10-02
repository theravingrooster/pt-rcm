import { and, eq, inArray, or, sql } from "drizzle-orm";
import { ClaimDocumentSchema, IdSchema, IsoDateSchema, UtcTimestampSchema } from "@pt-rcm/domain";
import type { ClearinghousePort, FixtureRemitScript } from "@pt-rcm/clearinghouse";
import type { Database } from "./index.js";
import { postRemit, RemitPostingError } from "./remit-post.js";
import * as s from "./schema.js";

/** Script only submitted fixture documents. Stable dates/versions make repeated
 * polling replay the same remit IDs, including after payment or process restart.
 */
export async function loadFixtureRemitScripts(db: Database, organizationId: string): Promise<FixtureRemitScript[]> {
  IdSchema.parse(organizationId);
  const claims = await db.select({ claim: s.claims }).from(s.claims)
    .innerJoin(s.encounters, eq(s.encounters.id, s.claims.encounterId))
    .where(and(eq(s.encounters.organizationId, organizationId), or(
      inArray(s.claims.status, ["SUBMITTED", "ACCEPTED"]),
      // Replay completed fixture receipts, but never synthesize a new 80/20
      // receipt for a claim already adjudicated by a different recorded remit.
      and(inArray(s.claims.status, ["DENIED", "PAID", "PATIENT_BALANCE"]), sql`exists (
        select 1 from ${s.remits} where ${s.remits.claimId} = ${s.claims.id}
        and ${s.remits.detailJson}->>'source' = 'fixture'
        and ${s.remits.detailJson}->>'claimVersion' = ${s.claims.version}::text
      )`),
    )))
    .orderBy(s.claims.id);
  return claims.flatMap(({ claim }) => {
    const receipt = claim.snapshotJson.submission;
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) || receipt.adapter !== "fixture") return [];
    const document = ClaimDocumentSchema.parse(receipt.document);
    if (document.claimId !== claim.id || document.claimVersion !== claim.version) throw new RemitPostingError(409, "SUBMISSION_VERSION_MISMATCH", "Fixture receipt does not describe the current claim version");
    const receivedOn = UtcTimestampSchema.parse(receipt.submittedAt).slice(0, 10);
    return [{ claimId: claim.id, claimVersion: claim.version, totalChargeCents: document.totalChargeCents,
      receivedOn, lines: document.lines.map(({ cptCode, units, chargeCents }) => ({ cptCode, units, chargeCents })) }];
  });
}

export async function pollRemits(db: Database, organizationId: string, since: string,
  options: { adapter: string | undefined; clearinghouse: Pick<ClearinghousePort, "fetchRemits"> }) {
  if (options.adapter !== "fixture") throw new RemitPostingError(503, "CLEARINGHOUSE_ADAPTER_DISABLED", "CLEARINGHOUSE_ADAPTER must be fixture");
  IdSchema.parse(organizationId); IsoDateSchema.or(UtcTimestampSchema).parse(since);
  const envelopes = await options.clearinghouse.fetchRemits(since);
  const results = [];
  for (const envelope of envelopes) results.push(await postRemit(db, organizationId, envelope, "fixture"));
  return { results };
}
