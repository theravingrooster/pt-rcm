import { z } from "zod";
import { getCptFixture } from "./fixtures/index.js";
import {
  AddressSchema, Icd10Schema, IdSchema, IsoDateSchema, MemberIdSchema,
  NonNegativeIntSchema, NpiSchema, PatientSexSchema, SubscriberRelationshipSchema,
} from "./models.js";

export const IngestPayerCodeSchema = z.enum(["MEDICARE", "SYN_COMMERCIAL"]);
export type IngestPayerCode = z.infer<typeof IngestPayerCodeSchema>;

// A structured name avoids ambiguity. A full name is also accepted: the first
// word is firstName and the remaining words are lastName, without dropping any.
const PatientNameSchema = z.union([
  z.object({ firstName: z.string().trim().min(1), lastName: z.string().trim().min(1) }).strict(),
  z.string().trim().regex(/^\S+\s+\S.*$/, "Supply first and last names")
    .transform((name) => {
      const separator = name.search(/\s/);
      return { firstName: name.slice(0, separator), lastName: name.slice(separator).trim() };
    }),
]);

export const EncounterIngestSchema = z.object({
  externalId: z.string().trim().min(1),
  patient: z.object({
    externalId: z.string().regex(/^SYN[A-Za-z0-9_-]+$/, "Use a synthetic patient identifier starting with SYN"),
    name: PatientNameSchema,
    dob: IsoDateSchema,
    sex: PatientSexSchema,
    address: AddressSchema,
    coverage: z.object({
      payerCode: IngestPayerCodeSchema,
      memberId: MemberIdSchema,
      relationship: SubscriberRelationshipSchema,
    }).strict(),
  }).strict(),
  renderingProviderNpi: NpiSchema,
  facilityId: IdSchema,
  dateOfService: IsoDateSchema,
  diagnoses: z.array(Icd10Schema),
  minuteLines: z.array(z.object({
    cptCode: z.string(),
    minutes: NonNegativeIntSchema,
  }).strict().superRefine((line, context) => {
    const fixture = getCptFixture(line.cptCode);
    if (!fixture) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["cptCode"], message: "Unknown procedure code in local fixture" });
    } else if (fixture.timed && line.minutes > 480) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["minutes"], message: "Timed minutes must be between 0 and 480" });
    }
  })),
  planOfCare: z.object({ signedDate: IsoDateSchema, certifyingNpi: NpiSchema }).strict().optional(),
  authorizationId: IdSchema.optional(),
}).strict();

export type EncounterIngestInput = z.input<typeof EncounterIngestSchema>;
export type EncounterIngest = z.infer<typeof EncounterIngestSchema>;
export type EncounterIngestResult = {
  encounterId: string;
  patientId: string;
  status: "DRAFT";
  created: boolean;
};
