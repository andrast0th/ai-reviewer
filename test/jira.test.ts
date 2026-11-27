import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JiraConfig } from "../src/config.ts";
import { DEFAULT_KEY_PATTERN } from "../src/config.ts";
import { fieldToText, parseIssue, wikiToText } from "../src/jira.ts";
import { silentLogger } from "../src/log.ts";
import { findIssueKeys, resolveTicket, ticketCandidates, ticketCell } from "../src/ticket.ts";
import { fakeFetch, fixtureJson } from "./helpers.ts";

const JIRA: JiraConfig = {
  url: "https://jira.test",
  keyPattern: DEFAULT_KEY_PATTERN,
  acceptanceCriteriaField: "customfield_10042",
  projects: [],
};
const ISSUE = "GET https://jira.test/rest/api/2/issue";

describe("findIssueKeys", () => {
  it("returns keys in source priority order, de-duplicated", () => {
    assert.deepEqual(
      findIssueKeys(
        ["BANK-12: fix", "feature/PAY-3-x", "Closes BANK-12, relates to OPS-9"],
        DEFAULT_KEY_PATTERN,
        [],
      ),
      ["BANK-12", "PAY-3", "OPS-9"],
    );
  });

  it("skips common false positives like UTF-8 and SHA-256", () => {
    assert.deepEqual(
      findIssueKeys(["use UTF-8 and SHA-256 for BANK-7", "ISO-8859-1"], DEFAULT_KEY_PATTERN, []),
      ["BANK-7"],
    );
  });

  it("honours the projects allowlist", () => {
    assert.deepEqual(findIssueKeys(["OPS-1 BANK-2 PAY-3"], DEFAULT_KEY_PATTERN, ["BANK", "PAY"]), [
      "BANK-2",
      "PAY-3",
    ]);
  });

  it("ignores keys with a leading zero or no number", () => {
    assert.deepEqual(findIssueKeys(["BANK-0 BANK-01 BANK-"], DEFAULT_KEY_PATTERN, []), []);
  });

  it("uses --ticket instead of searching", () => {
    assert.deepEqual(ticketCandidates(JIRA, "bank-5", ["BANK-12"]), ["BANK-5"]);
    assert.deepEqual(ticketCandidates(null, undefined, ["BANK-12"]), []);
  });
});

describe("Jira payloads", () => {
  it("cleans up wiki markup", () => {
    assert.equal(
      wikiToText(
        "h2. Context\r\n{code:java}\nx();\n{code}\nSee [runbook|https://w.test/r] {color:red}now{color}",
      ),
      "## Context\n\nx();\n\nSee runbook (https://w.test/r) now",
    );
  });

  it("reads acceptance criteria in the shapes plugins use", () => {
    assert.equal(fieldToText("* a\n* b"), "* a\n* b");
    assert.equal(fieldToText(["first", "second"]), "- first\n- second");
    assert.equal(
      fieldToText([{ name: "saved", checked: true }, { value: "rolled back" }]),
      "- saved\n- rolled back",
    );
    assert.equal(fieldToText({ value: "single option" }), "single option");
    assert.equal(fieldToText(null), "");
    assert.equal(fieldToText({ weird: 1 }), "");
  });

  it("parses an issue", () => {
    const t = parseIssue(
      fixtureJson("jira/issue-BANK-12.json"),
      "customfield_10042",
      "https://jira.test",
    );
    assert.ok(t);
    assert.equal(t.key, "BANK-12");
    assert.equal(t.issueType, "Story");
    assert.equal(t.status, "In Progress");
    assert.match(t.description, /^## Context\nTransfers currently/);
    assert.ok(!t.description.includes("{code"));
    assert.match(t.acceptanceCriteria, /one transaction/);
    assert.equal(t.url, "https://jira.test/browse/BANK-12");
    assert.match(
      ticketCell({ ticket: t, note: "" }),
      /^\[BANK-12\]\(https:\/\/jira\.test\/browse\/BANK-12\) Persist accounts after a transfer \(Story, In Progress\)$/,
    );
  });
});

describe("resolveTicket (fails soft)", () => {
  const log = silentLogger();

  it("explains why there is no ticket", async () => {
    assert.equal(
      (await resolveTicket(["BANK-1"], { jira: null, token: "t", log })).note,
      "Jira not configured",
    );
    assert.match(
      (await resolveTicket([], { jira: JIRA, token: "t", log })).note,
      /no issue key found/,
    );
    const noTok = await resolveTicket(["BANK-1"], { jira: JIRA, token: undefined, log });
    assert.equal(noTok.ticket, undefined);
    assert.match(noTok.warning ?? "", /JIRA_TOKEN is not set/);
  });

  it("skips keys that don't exist and asks only for the fields it needs", async () => {
    const f = fakeFetch({
      [`${ISSUE}/UTFX-1`]: { status: 404 },
      [`${ISSUE}/BANK-12`]: { json: fixtureJson("jira/issue-BANK-12.json") },
    });
    const r = await resolveTicket(["UTFX-1", "BANK-12"], {
      jira: JIRA,
      token: "jira-tok",
      log,
      fetch: f,
    });
    assert.equal(r.ticket?.key, "BANK-12");
    assert.equal(r.warning, undefined);
    assert.equal(
      f.calls[1]?.url.searchParams.get("fields"),
      "summary,description,issuetype,status,customfield_10042",
    );
    assert.equal(f.calls[1]?.headers.authorization, "Bearer jira-tok");
    assert.ok(
      f.calls.every((c) => c.method === "GET"),
      "never writes to Jira",
    );
  });

  it("warns and continues when Jira rejects the token", async () => {
    const f = fakeFetch({ [`${ISSUE}/BANK-12`]: { status: 401 } });
    const r = await resolveTicket(["BANK-12"], { jira: JIRA, token: "t", log, fetch: f });
    assert.equal(r.ticket, undefined);
    assert.match(r.warning ?? "", /Jira lookup failed: .*HTTP 401/);
  });

  it("tries at most three candidates", async () => {
    const f = fakeFetch({});
    const r = await resolveTicket(["A-1", "B-1", "C-1", "D-1"], {
      jira: JIRA,
      token: "t",
      log,
      fetch: f,
    });
    assert.equal(f.calls.length, 3);
    assert.match(r.note, /A-1 \(not found\), B-1 \(not found\), C-1 \(not found\)/);
  });
});
