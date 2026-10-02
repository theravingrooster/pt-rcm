import { allocateUnits, loadMedicareMinuteLadder } from "@pt-rcm/domain";
import type { ClaimDraft, RuleContext } from "../types.js";

const id = (suffix: string) => `10000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
export const testClaimId = id("20");

// Synthetic test data only. No patient, provider, or member identifies a person.
export function makeContext(mode: RuleContext["mode"] = "active"): RuleContext {
  const encounter = {
    id: id("1"), organizationId: id("2"), externalId: "SYN-RULES-ENCOUNTER",
    patientId: id("3"), renderingProviderId: id("4"), facilityId: id("5"),
    dateOfService: "2026-10-01", status: "DRAFT" as const, authorizationId: null,
  };
  const minuteLines = [
    { id: id("6"), encounterId: encounter.id, cptCode: "97110", minutes: 20, timed: true, notes: null },
    { id: id("7"), encounterId: encounter.id, cptCode: "97530", minutes: 20, timed: true, notes: null },
  ];
  return {
    encounter, minuteLines, allocatedUnits: allocateUnits(minuteLines, loadMedicareMinuteLadder()),
    coverage: {
      id: id("8"), patientId: encounter.patientId, payerId: id("9"), memberId: "SYN-RULES-MEMBER",
      groupNumber: null, planName: null, subscriberRelationship: "SELF", active: true,
    },
    payer: { id: id("9"), name: "SYN Test Payer", payerType: "COMMERCIAL", stediPayerId: null, requiresGpModifier: false },
    authorizations: [], planOfCare: null, yearToDateBilledCents: 240000, mode,
  };
}

export function makeDraft(ctx = makeContext()): ClaimDraft {
  return {
    encounterId: ctx.encounter.id,
    lines: ctx.allocatedUnits.lines.map(({ cptCode, minutes, units }) => ({
      cptCode, minutes, units, modifiers: [], diagnosisPointers: [0],
    })),
  };
}
