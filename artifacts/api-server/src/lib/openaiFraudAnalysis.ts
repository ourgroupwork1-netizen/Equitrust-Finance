import OpenAI from "openai";

export const OPENAI_FRAUD_MODEL = "gpt-5-mini";
export const MAX_AI_ACCOUNTS_PER_SCAN = 100;

export type AnonymizedTransactionSignal = {
  type: string;
  amountCents: number;
  minutesAgo: number;
  previouslyFlagged: boolean;
};

export type AnonymizedAccountSignal = {
  accountRef: number;
  transactions: AnonymizedTransactionSignal[];
};

export type AiRiskFinding = {
  accountRef: number;
  score: number;
  reasons: string[];
};

export class FraudAnalysisUnavailableError extends Error {
  constructor(readonly statusCode: 502 | 503) {
    super("OpenAI fraud analysis is unavailable.");
    this.name = "FraudAnalysisUnavailableError";
  }
}

const responseSchema = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          accountRef: { type: "integer", minimum: 0 },
          score: { type: "integer", minimum: 25, maximum: 100 },
          reasons: {
            type: "array",
            minItems: 1,
            maxItems: 3,
            items: { type: "string", minLength: 1, maxLength: 200 },
          },
        },
        required: ["accountRef", "score", "reasons"],
        additionalProperties: false,
      },
    },
  },
  required: ["findings"],
  additionalProperties: false,
} as const;

const instructions = [
  "You are an anomaly-review assistant for a simulated cooperative-finance ledger.",
  "Identify only transaction patterns that merit a human review. Do not decide that fraud occurred.",
  "Treat each accountRef as an arbitrary, temporary label, not a personal identity.",
  "A score from 25 to 100 is a review-priority indicator, never a probability or confidence that fraud occurred.",
  "Return only accounts with a concrete, data-supported pattern worth reviewing; return an empty findings array otherwise.",
  "Do not infer intent, identity, protected traits, creditworthiness, or loan eligibility.",
  "Use concise reasons grounded only in the supplied transaction types, amounts, relative times, and prior review flags.",
  "A high amount alone is not proof of wrongdoing. Legitimate activity is possible.",
].join(" ");

let client: OpenAI | undefined;

function getClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new FraudAnalysisUnavailableError(503);
  }

  client ??= new OpenAI({
    apiKey,
    maxRetries: 1,
    timeout: 45_000,
  });
  return client;
}

export async function analyzeTransactionSignals(
  accounts: AnonymizedAccountSignal[],
): Promise<AiRiskFinding[]> {
  if (accounts.length === 0) return [];

  let response;
  try {
    response = await getClient().responses.create({
      model: OPENAI_FRAUD_MODEL,
      instructions,
      input: JSON.stringify({ accounts }),
      max_output_tokens: 8192,
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: "fraud_review_findings",
          strict: true,
          schema: responseSchema,
        },
      },
    });
  } catch {
    throw new FraudAnalysisUnavailableError(
      process.env.OPENAI_API_KEY ? 502 : 503,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.output_text);
  } catch {
    throw new FraudAnalysisUnavailableError(502);
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("findings" in parsed) ||
    !Array.isArray(parsed.findings)
  ) {
    throw new FraudAnalysisUnavailableError(502);
  }

  const validRefs = new Set(accounts.map((account) => account.accountRef));
  const seenRefs = new Set<number>();
  const findings: AiRiskFinding[] = [];

  for (const item of parsed.findings) {
    if (
      typeof item !== "object" ||
      item === null ||
      !("accountRef" in item) ||
      !("score" in item) ||
      !("reasons" in item) ||
      typeof item.accountRef !== "number" ||
      !Number.isInteger(item.accountRef) ||
      !validRefs.has(item.accountRef) ||
      seenRefs.has(item.accountRef) ||
      typeof item.score !== "number" ||
      !Number.isInteger(item.score) ||
      item.score < 25 ||
      item.score > 100 ||
      !Array.isArray(item.reasons) ||
      item.reasons.length < 1 ||
      item.reasons.length > 3 ||
      item.reasons.some(
        (reason: unknown) =>
          typeof reason !== "string" ||
          reason.trim().length === 0 ||
          reason.length > 200,
      )
    ) {
      throw new FraudAnalysisUnavailableError(502);
    }

    seenRefs.add(item.accountRef);
    findings.push({
      accountRef: item.accountRef,
      score: item.score,
      reasons: item.reasons.map((reason: unknown) =>
        (reason as string).trim(),
      ),
    });
  }

  return findings;
}