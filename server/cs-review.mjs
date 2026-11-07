import { randomUUID } from "node:crypto";
import os from "node:os";
import { checkProof } from "./lean.mjs";
import { createContract } from "./contracts.mjs";
import { runNumericExperiment } from "./numeric-execution.mjs";
import { extractPaper } from "./pdf.mjs";
import { isHash, sha256 } from "./evidence.mjs";
import { checkRocqArtifact, rocqColumns } from "./rocq.mjs";
import { checkTlaArtifact, tlaColumns } from "./tla.mjs";
import { unknownModelOutcome } from "./model-delivery.mjs";
import { LIBRARY_PROFILES } from "../shared/library-profiles.mjs";
import {
  CS_ENGINE,
  classifyCsClaim,
  COMPUTATION_COMMAND,
  computationFiles,
  csPaperSummary,
  expectedLines,
  locateEach,
  locateQuote,
  needsSourceQuote,
  readCandidate,
  sourceSentence,
} from "../shared/cs-track.mjs";

const PROFILE_IDS = LIBRARY_PROFILES.map((profile) => profile.id);
const REPLAY_BANNED = [
  "expected",
  "code",
  "proof",
  "quote",
  "source",
  "claims",
  "leanTarget",
  "statement",
  "tolerance",
  "files",
  "command",
  "config",
  "bound",
  "expectedValues",
];
const PROPOSE_BANNED = [
  "expected",
  "code",
  "proof",
  "quote",
  "source",
  "claims",
  "leanTarget",
  "statement",
  "tolerance",
  "files",
  "command",
  "config",
  "bound",
  "expectedValues",
];
const CANDIDATE_SYSTEM = `只返回 JSON {"candidates":[{"sentence":"给定页面里的连续原句"}]}。sentence 必须逐字来自给定页面。不要返回种类、代码、期望输出、证明、文件或检查结论。最多 8 条。无法确定就返回 {"candidates":[]}。`;

const text = (value, max, name) => {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`${name}缺失或超限。`);
  return value.trim();
};

export function refuseMathReplay(engine) {
  if (engine === CS_ENGINE)
    throw new Error(
      "计算机评审可导出证据。沙箱输出和单条 Lean 检查不走数学复现入口。",
    );
}

function numericText(value) {
  return /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value);
}

function outputLines(stdout) {
  let text = String(stdout ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (text.endsWith("\n")) text = text.slice(0, -1);
  if (text === "") return [];
  return text.split("\n");
}

function comparisonRows(stdout, expected, tolerance) {
  const lines = outputLines(stdout);
  const width = Math.max(lines.length, expected.length);
  return Array.from({ length: width }, (_, index) => {
    const want = expected[index] ?? "";
    const actual = lines[index] ?? "";
    const compared = outputsMatch(actual, want, tolerance);
    const present = index < expected.length && actual !== "";
    return {
      expected: want,
      actual,
      matched: present && compared.matched,
      toleranceUsed: present && compared.toleranceUsed,
    };
  });
}

function mismatchReason(row) {
  if (!row?.expected)
    return row?.actual
      ? `隔离运行已经结束，输出多出「${row.actual}」，原文没有这一行对照值。`
      : "隔离运行已经结束，输出多出一行空行，原文没有这一行对照值。";
  if (!row.actual)
    return `隔离运行已经结束，原文对照「${row.expected}」没有对应输出。`;
  return `隔离运行已经结束，输出与原文中的对照值不符。对照「${row.expected}」得到「${row.actual}」。`;
}

function matchValues(stdout, expected, tolerance) {
  const rows = comparisonRows(stdout, expected, tolerance);
  return rows.length === expected.length && rows.every((row) => row.matched);
}

function decimalValue(text) {
  const match = /^([+-]?)(\d+(?:\.\d+)?|\.\d+)(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) return null;
  const body = match[2];
  const point = body.indexOf(".");
  const fraction = point < 0 ? 0n : BigInt(body.length - point - 1);
  const digits = body.replace(".", "").replace(/^0+(?=\d)/, "");
  if (digits.length > 10000) return null;
  let exponent = 0n;
  if (match[3]) {
    if (match[3].replace(/^[+-]/, "").length > 6) return null;
    exponent = BigInt(match[3]);
  }
  const scale = exponent - fraction;
  if (scale > 10000n || scale < -10000n) return null;
  const coeff = BigInt(digits);
  return { sign: coeff === 0n || match[1] !== "-" ? 1n : -1n, coeff, scale };
}

function withinDecimalTolerance(got, want, tolerance) {
  const left = decimalValue(got);
  const right = decimalValue(want);
  const allowed = decimalValue(String(tolerance));
  if (!left || !right || !allowed || allowed.sign < 0n) return false;
  const places = [0n, left.scale, right.scale, allowed.scale].reduce((min, scale) =>
    scale < min ? scale : min,
  );
  const lift = (value) =>
    value.sign * value.coeff * 10n ** (value.scale - places);
  const difference = lift(left) - lift(right);
  const size = difference < 0n ? -difference : difference;
  return size <= lift(allowed);
}

function outputsMatch(stdout, expected, tolerance) {
  const got = String(stdout ?? "");
  const want = String(expected ?? "");
  if (got === want) return { matched: true, toleranceUsed: false };
  if (tolerance == null || !numericText(got) || !numericText(want))
    return { matched: false, toleranceUsed: false };
  const matched = withinDecimalTolerance(got, want, tolerance);
  return { matched, toleranceUsed: matched };
}

function locationReason(status) {
  if (status === "repeated") return "这句话在原文中出现了多次，未运行检查。";
  if (status === "embedded")
    return "这个数字只出现在更长的数字里，未运行检查。";
  if (status === "used")
    return "这个对照值在原文里没有另一处独立出现，未运行检查。";
  return "这句话没有出现在提取出的原文中，未运行检查。";
}

function unlocated(found) {
  return {
    outcome: "source_unlocated",
    reason: locationReason(found.status),
    certificate: null,
  };
}

export class CsReview {
  constructor({
    store,
    checker = checkProof,
    experiment = runNumericExperiment,
    extract = extractPaper,
    rocq = checkRocqArtifact,
    tla = checkTlaArtifact,
    model = null,
    getConfig = async () => null,
  }) {
    if (!store) throw new Error("计算机评审缺少证据存储。");
    this.store = store;
    this.checker = checker;
    this.experiment = experiment;
    this.extract = extract;
    this.rocq = rocq;
    this.tla = tla;
    this.model = model;
    this.getConfig = getConfig;
  }

  async start(input) {
    if (!input || typeof input !== "object")
      throw new Error("计算机评审请求无效。");
    if (input.track && input.track !== "cs")
      throw new Error("计算机评审的类型标记无效。");
    if (input.orchestration && input.orchestration !== "cs")
      throw new Error("计算机论文不能进入数学自主评审。");
    if (!isHash(input.paperSha256) || typeof input.pdfBase64 !== "string")
      throw new Error("论文身份或文件内容无效。");
    if (input.pdfBase64.length > 36 * 1024 * 1024)
      throw new Error("论文文件超过本机处理预算。");
    const bytes = Buffer.from(input.pdfBase64, "base64");
    if (!bytes.length || sha256(bytes) !== input.paperSha256)
      throw new Error("论文摘要与文件不一致。");
    const supplied = input.claims === undefined ? [] : input.claims;
    if (!Array.isArray(supplied) || supplied.length > 16)
      throw new Error("主张清单无效。");
    for (const claim of supplied) validateClaim(claim);
    await this.store.init();
    const run = {
      id: randomUUID(),
      engine: CS_ENGINE,
      track: "cs",
      orchestration: "cs",
      status: "running",
      createdAt: new Date().toISOString(),
      pageIndex: Number.isInteger(input.pageIndex) ? input.pageIndex : 0,
      paperSha256: input.paperSha256,
      modelCalls: 0,
      modelInvoked: false,
      csClaims: [],
      conclusion: null,
      root: null,
      tasks: [],
    };
    await this.store.saveRun(run);
    void this.finish(run, input, supplied).catch(async (error) => {
      run.status = "incomplete";
      run.stopReason = error.message || "计算机评审未能归档。";
      run.conclusion = {
        ...csPaperSummary(run.csClaims),
        headline: "计算机评审未能完成归档",
      };
      await this.store.saveRun(run).catch(() => {});
    });
    return structuredClone(run);
  }

  async finish(run, input, supplied) {
    const sourceArtifact = await this.store.put("cs_paper_source", {
      paperSha256: input.paperSha256,
      pdfBase64: input.pdfBase64,
    });
    run.sourceArtifact = sourceArtifact;
    let pages = [];
    if (supplied.length) {
      try {
        pages = (await this.extract(input.pdfBase64)).pages || [];
      } catch (error) {
        pages = [];
        run.extractionError = error.message || "原文文本未能提取。";
      }
    }
    const claims = [];
    const claimArtifacts = [];
    const list = supplied.length
      ? supplied
      : [{ kind: "unknown", statement: "未提交具体主张。" }];
    for (const [index, raw] of list.entries()) {
      const built = await this.evaluateClaim(
        input.paperSha256,
        sourceArtifact,
        pages,
        raw,
        index,
      );
      const artifact = await this.store.put("cs_claim", {
        paperSha256: input.paperSha256,
        claim: built,
      });
      built.artifact = artifact;
      claimArtifacts.push(artifact);
      claims.push(built);
    }
    return this.seal(run, input.paperSha256, sourceArtifact, claims, claimArtifacts);
  }

  async evaluateClaim(paperSha256, sourceArtifact, pages, raw, index) {
    const classified = classifyCsClaim(raw, PROFILE_IDS);
    const claim = {
      id: `c${index}`,
      kind: classified.kind,
      label: textOr(raw.label, KIND_FALLBACK[classified.kind], 120),
      statement: textOr(raw.statement, "未填写表述。", 2000),
      outcome: classified.outcome,
      reason: classified.reason,
      certificate: null,
    };
    if (classified.disposition === "execute_computation") {
      const located = locateEach(pages, expectedLines(raw));
      if (located.status !== "unique")
        return Object.assign(claim, unlocated(located));
      claim.sourceQuote = located.items.map((item) => item.quote).join("\n");
      claim.pageIndex = located.items[0].page.index;
      return Object.assign(claim, await this.compare(raw, located.items));
    }
    if (!needsSourceQuote(classified)) return claim;
    const found = locateQuote(pages, sourceSentence(raw));
    if (found.status !== "unique") return Object.assign(claim, unlocated(found));
    claim.sourceQuote = found.quote;
    claim.pageIndex = found.page.index;
    if (classified.kind === "prose_proof") {
      claim.outcome = "unmechanized";
      claim.reason = "原句已在原文中唯一定位。散文证明未进入证明器。";
      return claim;
    }
    if (classified.outcome === "incomplete_proof") {
      claim.outcome = "incomplete_proof";
      claim.reason = "原句已定位。证明含未完成标记或禁止指令，未交给 Lean。";
      return claim;
    }
    if (classified.disposition === "execute_lean")
      return Object.assign(
        claim,
        await this.prove(paperSha256, sourceArtifact, found, raw),
      );
    if (classified.disposition === "execute_rocq")
      return Object.assign(claim, await this.mechanize(found, raw));
    if (classified.disposition === "execute_tla")
      return Object.assign(claim, await this.boundCheck(found, raw));
    return claim;
  }

  async compare(raw, located) {
    const quotes = located.map((item) => item.quote);
    const listed = computationFiles(raw);
    const tolerance = raw.tolerance ?? null;
    if (!listed.ok) {
      return {
        outcome: "not_run",
        reason: listed.reason,
        certificate: null,
        execution: {
          kind: "computation",
          code: raw.code,
          command: COMPUTATION_COMMAND,
          expectedValues: quotes,
          expected: quotes.join("\n"),
          tolerance,
          ...(Array.isArray(raw.files) ? { files: raw.files } : {}),
        },
      };
    }
    const files = listed.files;
    const execution = {
      kind: "computation",
      code: raw.code,
      command: COMPUTATION_COMMAND,
      expectedValues: quotes,
      expected: quotes.join("\n"),
      tolerance,
    };
    if (files.length) execution.files = files;
    try {
      const result = await this.experiment(os.tmpdir(), raw.code, { files });
      const rows = comparisonRows(result.stdout, quotes, tolerance);
      const matched =
        result.exitCode === 0 &&
        !result.termination &&
        rows.length === quotes.length &&
        rows.every((row) => row.matched);
      const finished = result.exitCode === 0 && !result.termination;
      const missed = rows.find((row) => !row.matched);
      const toleranceUsed = rows.some((row) => row.toleranceUsed);
      return {
        outcome: finished
          ? matched
            ? toleranceUsed
              ? "within_tolerance"
              : "reproduced"
            : "mismatch"
          : "execution_failed",
        reason: finished
          ? matched
            ? toleranceUsed
              ? `隔离运行的输出与原文相差不超过 ${tolerance}。这不是数学证明。`
              : "隔离运行的输出与原文中的对照值一致。这不是数学证明。"
            : mismatchReason(missed)
          : "隔离运行没有正常结束，不能记为数字一致。",
        ...(finished ? { comparisons: rows } : {}),
        execution,
        receipt: {
          exitCode: result.exitCode,
          termination: result.termination || null,
          stdout: String(result.stdout || "").slice(0, 4000),
          stdoutSha256: sha256(String(result.stdout || "")),
          codeSha256: sha256(raw.code),
          command: COMPUTATION_COMMAND,
          fileNames: files.map((file) => file.name),
          expectedSha256: sha256(quotes.join("\n")),
          scope: "executed_finite_experiment_not_a_theorem_certificate",
          verified: false,
        },
      };
    } catch (error) {
      return {
        outcome: "execution_failed",
        reason: error.message || "计算未能完成。",
        execution,
        certificate: null,
      };
    }
  }

  async prove(paperSha256, sourceArtifact, found, raw) {
    const execution = {
      kind: "lean",
      proof: raw.proof.trim(),
      leanTarget: raw.leanTarget,
      profileId: raw.profileId,
      quote: found.quote,
      pageIndex: found.page.index,
      pageText: found.page.text,
    };
    try {
      const contract = createContract(
        {
          paperSha256,
          pageIndex: found.page.index,
          artifact: sourceArtifact,
          text: found.page.text,
        },
        {
          label: textOr(raw.label, "计算机论文中的数学命题", 120),
          quote: found.quote,
          statement: textOr(raw.statement, found.quote, 2000),
          assumptions: [],
          leanTarget: raw.leanTarget,
          ambiguity: "",
        },
        raw.profileId,
      );
      const check = await this.checker(contract, execution.proof);
      const proved =
        check?.status === "verified" && check.targetHash === contract.targetHash;
      return {
        outcome:
          check?.status === "tool_unavailable"
            ? "tool_unavailable"
            : proved
              ? "formalized_proved"
              : "lean_unproved",
        reason: proved
          ? "Lean 检查了这一条精确目标。整篇论文并未因此通过。"
          : check?.reason || "Lean 已执行，这一条命题没有取得证明。",
        certificate: proved ? "lean" : null,
        execution,
        receipt: {
          status: check?.status || "not_verified",
          targetHash: contract.targetHash,
          profileId: raw.profileId,
          axioms: Array.isArray(check?.axioms) ? check.axioms : [],
        },
      };
    } catch (error) {
      return {
        outcome: "lean_unproved",
        reason: error.message || "Lean 检查未能完成。",
        certificate: null,
        execution,
      };
    }
  }

  async mechanize(found, raw) {
    const result = await this.rocq(raw.source, {});
    const clean =
      result.make === "ok" &&
      result.validate === "ok" &&
      result.closed &&
      result.admits.length === 0 &&
      result.extraAxioms.length === 0;
    const outcome =
      result.make === "unavailable" || result.make === "not_run"
        ? result.make === "not_run"
          ? "mechanized_incomplete"
          : "tool_unavailable"
        : result.make !== "ok"
          ? "execution_failed"
          : clean
            ? "mechanized_checked"
            : "mechanized_incomplete";
    return {
      outcome,
      reason: clean
        ? "make check 已重放，公理清单为空。这不是整篇论文的证明完成。"
        : result.reason ||
          "Rocq 记录已保存。存在 admit、额外公理或重放失败时，不能视为证明完成。",
      certificate: null,
      columns: rocqColumns(result, found),
      execution: {
        kind: "rocq",
        source: raw.source,
        quote: found.quote,
        pageIndex: found.page.index,
      },
      receipt: {
        make: result.make,
        validate: result.validate || "not_run",
        closed: !!result.closed,
        admits: result.admits || [],
        extraAxioms: result.extraAxioms || [],
        commands: result.commands,
        version: result.version || null,
        platform: result.platform || null,
        theoremName: result.theoremName || null,
      },
    };
  }

  async boundCheck(found, raw) {
    const result = await this.tla(raw.source, {
      config: raw.config,
      bound: raw.bound,
    });
    const outcome =
      result.make === "unavailable"
        ? "tool_unavailable"
        : result.make === "not_run"
          ? "not_run"
          : result.counterexample
            ? "bounded_counterexample"
            : result.make === "ok" && result.boundRecorded
              ? "bounded_checked"
              : "execution_failed";
    return {
      outcome,
      reason:
        outcome === "bounded_checked"
          ? "在给定深度内仿真了一条行为，没有发现错误。其余行为和更深处没有检查。这不是证明完成。"
          : outcome === "bounded_counterexample" && result.deadlock
            ? "在搜索界内发现一条无法继续的行为。这不是证明完成，也不是整篇论文的否证。"
            : outcome === "bounded_counterexample" && result.temporal
              ? "在搜索界内发现一条违反时序性质的行为。这不是证明完成，也不是整篇论文的否证。"
            : outcome === "bounded_counterexample" && result.counterexample
              ? "在搜索界内发现一条行为。这不是证明完成，也不是整篇论文的否证。"
            : result.reason || "TLA+ 有界搜索没有完成，不能视为证明。",
      certificate: null,
      columns: tlaColumns(result, found),
      execution: {
        kind: "tla",
        source: raw.source,
        config: raw.config,
        bound: raw.bound,
        quote: found.quote,
        pageIndex: found.page.index,
      },
      receipt: {
        make: result.make,
        bound: result.bound || null,
        counterexample: !!result.counterexample,
        commands: result.commands,
        version: result.version || null,
        jarSha256: result.jarSha256 || null,
      },
    };
  }

  async seal(run, paperSha256, sourceArtifact, claims, claimArtifacts) {
    run.csClaims = claims;
    run.conclusion = csPaperSummary(claims);
    run.root = await this.store.put(
      "cs_review",
      {
        schemaVersion: "lemma.cs-review.v2",
        paperSha256,
        modelInvoked: false,
        outcomes: claims.map((claim) => ({
          id: claim.id,
          kind: claim.kind,
          outcome: claim.outcome,
        })),
      },
      [sourceArtifact, ...claimArtifacts],
    );
    run.status = "incomplete";
    await this.store.saveRun(run);
    return run;
  }

  async replay(runId, input = {}) {
    if (!isHash(runId) && !/^[a-f0-9-]{36}$/.test(runId))
      throw new Error("计算机重放记录无效。");
    if (input && REPLAY_BANNED.some((key) => key in input))
      throw new Error("计算机重放不接受新的期望输出或证明。");
    await this.store.init();
    const previous = await this.store.getRun(runId);
    if (previous.engine !== CS_ENGINE)
      throw new Error("这条记录不是计算机评审。");
    if (previous.status === "running" || previous.status === "preparing")
      throw new Error("计算机评审仍在进行，不能重放。");
    if (!previous.root) throw new Error("计算机评审还没有可重放的归档。");
    const claims = [];
    const artifacts = [];
    let differs = false;
    for (const [index, pointer] of (previous.csClaims || []).entries()) {
      const archived = (await this.store.get(pointer.artifact)).payload.claim;
      const next = await this.rerun(previous, archived, index);
      if (claimChanged(archived, next)) differs = true;
      const artifact = await this.store.put("cs_claim", {
        paperSha256: previous.paperSha256,
        claim: next,
        replayOf: pointer.artifact,
      });
      next.artifact = artifact;
      artifacts.push(artifact);
      claims.push(next);
    }
    const run = {
      id: randomUUID(),
      engine: CS_ENGINE,
      track: "cs",
      orchestration: "cs",
      status: "incomplete",
      createdAt: new Date().toISOString(),
      pageIndex: previous.pageIndex,
      paperSha256: previous.paperSha256,
      sourceArtifact: previous.sourceArtifact,
      replayOf: previous.id,
      previousRoot: previous.root,
      modelCalls: 0,
      modelInvoked: false,
      csClaims: claims,
      tasks: [],
      conclusion: {
        ...csPaperSummary(claims),
        replayOf: previous.id,
        previousRoot: previous.root,
        differs,
        notice: `${csPaperSummary(claims).notice}${
          differs
            ? "这次重放和原记录不一致。两次结果都保留，旧记录没有被覆盖。"
            : replayNotice(claims)
        }`,
      },
    };
    run.root = await this.store.put(
      "cs_replay",
      {
        schemaVersion: "lemma.cs-replay.v1",
        paperSha256: previous.paperSha256,
        replayOf: previous.id,
        previousRoot: previous.root,
        differs,
        modelInvoked: false,
        outcomes: claims.map((claim) => ({
          id: claim.id,
          kind: claim.kind,
          outcome: claim.outcome,
        })),
      },
      [previous.root, ...artifacts],
    );
    await this.store.saveRun(run);
    return run;
  }

  async rerun(previous, archived, index) {
    const claim = {
      id: `c${index}`,
      kind: archived.kind,
      label: archived.label,
      statement: archived.statement,
      outcome: archived.outcome,
      reason: archived.reason,
      certificate: archived.certificate ?? null,
      replayedFrom: archived.artifact || null,
    };
    if (typeof archived.sourceQuote === "string")
      claim.sourceQuote = archived.sourceQuote;
    if (Number.isInteger(archived.pageIndex))
      claim.pageIndex = archived.pageIndex;
    if (archived.columns) claim.columns = archived.columns;
    if (archived.execution?.kind === "computation") {
      if (
        archived.execution.command &&
        archived.execution.command !== COMPUTATION_COMMAND
      )
        return {
          ...claim,
          outcome: "not_run",
          reason: "归档的命令不是 python3 experiment.py，未重新运行。",
          certificate: null,
        };
      const quotes =
        Array.isArray(archived.execution.expectedValues) &&
        archived.execution.expectedValues.length
          ? archived.execution.expectedValues
          : [archived.execution.expected];
      const again = await this.compare(
        {
          code: archived.execution.code,
          tolerance: archived.execution.tolerance,
          files: archived.execution.files || [],
          command: COMPUTATION_COMMAND,
        },
        quotes.map((quote) => ({
          quote,
          page: { index: archived.pageIndex || 0 },
        })),
      );
      return {
        ...claim,
        ...again,
        sourceQuote: quotes.join("\n"),
      };
    }
    if (archived.execution?.kind === "lean") {
      const again = await this.prove(
        previous.paperSha256,
        previous.sourceArtifact,
        {
          quote: archived.execution.quote,
          page: {
            index: archived.execution.pageIndex,
            text: archived.execution.pageText,
          },
        },
        archived.execution,
      );
      return { ...claim, ...again, sourceQuote: archived.execution.quote };
    }
    if (archived.execution?.kind === "rocq") {
      if (
        typeof archived.execution.source !== "string" ||
        !archived.execution.source.trim()
      )
        return claim;
      const again = await this.mechanize(
        {
          quote: archived.execution.quote,
          page: { index: archived.execution.pageIndex },
        },
        { source: archived.execution.source },
      );
      return { ...claim, ...again, sourceQuote: archived.execution.quote };
    }
    if (archived.execution?.kind === "tla") {
      if (
        typeof archived.execution.source !== "string" ||
        !archived.execution.source.trim()
      )
        return claim;
      const again = await this.boundCheck(
        {
          quote: archived.execution.quote,
          page: { index: archived.execution.pageIndex },
        },
        {
          source: archived.execution.source,
          config: archived.execution.config,
          bound: archived.execution.bound,
        },
      );
      return { ...claim, ...again, sourceQuote: archived.execution.quote };
    }
    return claim;
  }

  async proposeCandidates(input = {}) {
    if (!input || typeof input !== "object")
      throw new Error("计算机候选请求无效。");
    if (PROPOSE_BANNED.some((key) => key in input))
      throw new Error("候选请求不接受代码、证明或期望输出。");
    if (!isHash(input.paperSha256) || typeof input.pdfBase64 !== "string")
      throw new Error("论文身份或文件内容无效。");
    const bytes = Buffer.from(input.pdfBase64, "base64");
    if (!bytes.length || sha256(bytes) !== input.paperSha256)
      throw new Error("论文摘要与文件不一致。");
    if (!this.model) throw new Error("计算机候选没有模型传输。");
    await this.store.init();
    const pages = (await this.extract(input.pdfBase64)).pages || [];
    const bounded = boundPages(pages);
    let result;
    try {
      result = await this.model(await this.getConfig(), {
        role: "cs_claim_candidate",
        budgetPurpose: "cs_claim_candidate",
        logicalStage: "cs_claim_candidate",
        system: CANDIDATE_SYSTEM,
        input: { pages: bounded.pages, truncated: bounded.truncated },
        maxTokens: 2000,
      });
    } catch (error) {
      if (error.modelRecord && unknownModelOutcome(error.modelRecord)) {
        return this.archiveCandidates(input.paperSha256, {
          status: "unknown",
          unknown: true,
          retried: false,
          candidates: [],
          notice: "模型结果未知，没有自动重试，也没有运行检查。",
          receipt: modelReceipt(error.modelRecord),
        });
      }
      throw error;
    }
    const supplied = result?.parsed?.candidates;
    const list = Array.isArray(supplied) ? supplied.slice(0, 8) : [];
    const candidates = list.map((item, index) => {
      const read = readCandidate(item);
      const sentence = read?.sentence || "";
      const found = locateEach(pages, [sentence]);
      const base = {
        id: `k${index}`,
        sentence,
        discarded: read?.discarded || [],
        certificate: null,
      };
      if (!sentence || !read || found.status !== "unique")
        return {
          ...base,
          status: "source_unlocated",
          reason: locationReason(found.status),
        };
      return {
        ...base,
        status: "candidate",
        pageIndex: found.items[0].page.index,
        sourceQuote: found.items[0].quote,
        reason: "原句已唯一定位。这是候选，选定种类并提交之后才会检查这句。",
      };
    });
    return this.archiveCandidates(input.paperSha256, {
      status: Array.isArray(supplied) ? "recorded" : "invalid",
      unknown: false,
      retried: false,
      candidates,
      notice: Array.isArray(supplied)
        ? "这些只是原文候选。选定种类并附上程序、工件或证明之后，才会检查对应的原句。"
        : "模型返回的候选格式无效，没有运行检查。",
      receipt: modelReceipt(result?.record),
    });
  }

  async archiveCandidates(paperSha256, body) {
    const root = await this.store.put("cs_candidates", {
      schemaVersion: "lemma.cs-candidates.v1",
      paperSha256,
      modelInvoked: true,
      modelCalls: 1,
      theorem: "unknown",
      reviewComplete: false,
      ...body,
    });
    return {
      root,
      paperSha256,
      modelInvoked: true,
      modelCalls: 1,
      theorem: "unknown",
      reviewComplete: false,
      ...body,
    };
  }
}

const KIND_FALLBACK = {
  unknown: "未分类主张",
  prose_proof: "散文证明",
  computation: "计算核对",
  math: "数学命题",
  mechanized_artifact: "机器证明工件",
  other: "其他实验",
};

function validateClaim(claim) {
  if (!claim || typeof claim !== "object" || Array.isArray(claim))
    throw new Error("主张清单无效。");
  if (claim.statement !== undefined) text(claim.statement, 2000, "主张表述");
  if (typeof claim.code === "string" && claim.code.length > 64000)
    throw new Error("计算代码超限。");
  if (typeof claim.source === "string" && claim.source.length > 200000)
    throw new Error("证明源码超限。");
  if (claim.files !== undefined) {
    if (!Array.isArray(claim.files) || claim.files.length > 6)
      throw new Error("附加文件无效。");
    for (const file of claim.files) {
      if (
        !file ||
        typeof file.name !== "string" ||
        typeof file.content !== "string" ||
        file.content.length > 64000
      )
        throw new Error("附加文件无效。");
    }
  }
  if (claim.command !== undefined && claim.command !== COMPUTATION_COMMAND)
    throw new Error("计算命令无效。");
  if (claim.config !== undefined) text(claim.config, 64000, "TLA 配置");
  if (
    claim.bound !== undefined &&
    (!Number.isInteger(claim.bound) || claim.bound < 1 || claim.bound > 20)
  )
    throw new Error("搜索界无效。");
  if (
    claim.tolerance !== undefined &&
    (typeof claim.tolerance !== "number" ||
      !Number.isFinite(claim.tolerance) ||
      claim.tolerance < 0 ||
      claim.tolerance > 1_000_000)
  )
    throw new Error("数值容差无效。");
}

function comparisonRowsMatch(left, right) {
  const a = Array.isArray(left) ? left : [];
  const b = Array.isArray(right) ? right : [];
  if (a.length !== b.length) return false;
  return a.every((row, index) => {
    const other = b[index] || {};
    return (
      row.expected === other.expected &&
      row.actual === other.actual &&
      row.matched === other.matched &&
      !!row.toleranceUsed === !!other.toleranceUsed
    );
  });
}

function claimChanged(archived, next) {
  if (next.outcome !== archived.outcome) return true;
  if (!comparisonRowsMatch(archived.comparisons, next.comparisons)) return true;
  const leftHash = archived.receipt?.stdoutSha256 || null;
  const rightHash = next.receipt?.stdoutSha256 || null;
  if (leftHash && rightHash && leftHash !== rightHash) return true;
  const left = archived.columns;
  const right = next.columns;
  if (!left && !right) return false;
  if (!left || !right) return true;
  return (
    left.make !== right.make ||
    left.axioms !== right.axioms ||
    left.bound !== right.bound ||
    left.trace !== right.trace ||
    left.correspondence !== right.correspondence
  );
}

function replayNotice(claims) {
  const kinds = new Set(
    (claims || []).map((claim) => claim.execution?.kind).filter(Boolean),
  );
  const parts = [];
  if (kinds.has("computation")) parts.push("沙箱代码");
  if (kinds.has("lean")) parts.push("Lean 证明");
  if (kinds.has("rocq")) parts.push("Rocq 源码");
  if (kinds.has("tla")) parts.push("TLA+ 规格");
  const used = parts.length ? parts.join("、") : "记录";
  const glue = /^[A-Za-z]/.test(used) ? " " : "";
  return `这次重放使用了归档的${glue}${used}，没有接受新的期望输出或证明。`;
}

function modelReceipt(record) {
  if (!record || typeof record !== "object") return null;
  return {
    requestId: record.requestId || null,
    model: record.model || null,
    finishReason: record.finishReason || null,
    errorCode: record.error?.code || null,
  };
}

function boundPages(pages) {
  const cap = 800000;
  let used = 0;
  let truncated = false;
  const next = [];
  for (const page of pages || []) {
    const text = String(page?.text || "");
    if (used >= cap) {
      truncated = true;
      break;
    }
    const slice = text.slice(0, cap - used);
    if (slice.length < text.length) truncated = true;
    next.push({ index: Number.isInteger(page?.index) ? page.index : next.length, text: slice });
    used += slice.length;
  }
  return { pages: next, truncated };
}

function textOr(value, fallback, max) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value.trim().slice(0, max);
}
