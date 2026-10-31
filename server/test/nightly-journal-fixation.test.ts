import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  NightlyMemoryTaskService,
  type NightlySleepAgentReport,
} from "../src/services/nightly-memory-task-service.js";

function withTempReportFile(): { reportFile: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "nightly-report-"));
  const reportFile = join(dir, "reports.json");
  const prev = process.env.AGENT_MEMORY_SLEEP_REPORT_FILE;
  process.env.AGENT_MEMORY_SLEEP_REPORT_FILE = reportFile;
  return {
    reportFile,
    cleanup: () => {
      if (prev === undefined) delete process.env.AGENT_MEMORY_SLEEP_REPORT_FILE;
      else process.env.AGENT_MEMORY_SLEEP_REPORT_FILE = prev;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

type Internals = {
  getAllActorIds(): string[];
  lastJournalFixation: NightlySleepAgentReport["journalFixation"] | null;
  runDreamPhase(): Promise<void>;
};

test("夜间报告：只有 journal 固化也得落报告，附当天计数", async () => {
  const { reportFile, cleanup } = withTempReportFile();
  try {
    const svc = new NightlyMemoryTaskService({ enabled: true });
    const internals = svc as unknown as Internals;
    internals.getAllActorIds = () => ["u-1"];
    internals.lastJournalFixation = { actors: 1, lines: 4, eventLines: 2, failed: 0 };

    await internals.runDreamPhase();

    const latest = svc.getLatestReport();
    assert.deepEqual(latest?.journalFixation, { actors: 1, lines: 4, eventLines: 2, failed: 0 });
    assert.deepEqual(latest?.reports, []);
    const persisted = JSON.parse(readFileSync(reportFile, "utf8")) as NightlySleepAgentReport[];
    assert.deepEqual(persisted[0]?.journalFixation, latest?.journalFixation);
  } finally {
    cleanup();
  }
});

test("夜间报告：当天无固化且无睡眠报告时不留空报告", async () => {
  const { cleanup } = withTempReportFile();
  try {
    const svc = new NightlyMemoryTaskService({ enabled: true });
    const internals = svc as unknown as Internals;
    internals.getAllActorIds = () => ["u-1"];
    internals.lastJournalFixation = null;

    await internals.runDreamPhase();

    assert.equal(svc.getLatestReport(), null);
  } finally {
    cleanup();
  }
});
