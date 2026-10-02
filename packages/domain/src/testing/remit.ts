import type { RemittableClaim, RemitEnvelope } from "../remit.js";
import { makeClaimDocumentInput } from "./claimDocument.js";

export function makeRemitClaim(): RemittableClaim {
  const { claim, claimLines } = makeClaimDocumentInput();
  return { ...claim, status: "ACCEPTED", lines: claimLines };
}

export function makeRemitEnvelope(claim = makeRemitClaim()): RemitEnvelope {
  return {
    id: "00000000-0000-4000-8000-000000000090", claimId: claim.id,
    payerIcn: `SYN-ICN-${claim.id}`, receivedOn: "2026-10-02",
    paidCents: claim.totalChargeCents, patientResponsibilityCents: 0, adjustments: [],
    lines: claim.lines.map((line) => ({ cptCode: line.cptCode, units: line.units,
      paidCents: line.chargeCents, patientResponsibilityCents: 0, adjustments: [], rarc: null })),
  };
}
