import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { packSignatures } from "../src/context/packer.ts";

// SYNTHETIC sources written for these tests.
const JAVA = `package com.acme.bank;

import java.util.List;

/** Accounts. */
@Service
public class AccountService {
  private final AccountRepository repo; // the repo
  private static final String X = "{ not a brace";

  public AccountService(AccountRepository repo) {
    this.repo = repo;
  }

  public Account find(String id) throws NotFoundException {
    if (id == null) { throw new IllegalArgumentException("}"); }
    return repo.find(id).orElseThrow();
  }

  public List<Account> all(
      int page,
      int size)
  {
    return repo.all(page, size);
  }

  public enum Status { OPEN, CLOSED }

  interface Listener {
    void onChange(Account a);
  }
}
`;

const TS = `import { x } from "./x";

export interface User {
  id: string;
  name?: string;
}

export type Opts = {
  retries: number;
};

/* block
   comment { */
export async function loadUser(id: string): Promise<User> {
  const res = await fetch(\`/api/users/\${id}\` + "{");
  if (!res.ok) {
    throw new Error("}");
  }
  return res.json();
}

export const saveUser = async (u: User): Promise<void> => {
  await fetch("/api", { method: "PUT" });
};

export class Repo {
  private cache = new Map<string, User>();
  get(id: string): User | undefined {
    return this.cache.get(id);
  }
}
`;

const KOTLIN = `package com.acme

import kotlinx.coroutines.*

data class Money(val cents: Long) {
  operator fun plus(o: Money) = Money(cents + o.cents)
  fun isZero(): Boolean {
    return cents == 0L
  }
}

object Registry {
  fun add(s: String) { items.add(s) }
}
`;

describe("packSignatures", () => {
  it("keeps Java types and member signatures, collapses bodies", () => {
    const out = packSignatures(JAVA);
    assert.equal(
      out,
      `@Service
public class AccountService {
  private final AccountRepository repo; // the repo
  private static final String X = "{ not a brace";

  public AccountService(AccountRepository repo) { … }

  public Account find(String id) throws NotFoundException { … }

  public List<Account> all(
      int page,
      int size) { … }

  public enum Status { OPEN, CLOSED }

  interface Listener {
    void onChange(Account a);
  }
}`,
    );
  });

  it("keeps TS interfaces and types whole, collapses functions; ignores braces in strings and comments", () => {
    const out = packSignatures(TS);
    assert.match(out, /export interface User \{\n {2}id: string;\n {2}name\?: string;\n\}/);
    assert.match(out, /export type Opts = \{\n {2}retries: number;\n\};/);
    assert.match(out, /^export async function loadUser\(id: string\): Promise<User> \{ … \}$/m);
    assert.match(out, /^export const saveUser = async \(u: User\): Promise<void> => \{ … \}$/m);
    assert.match(out, /^ {2}get\(id: string\): User \| undefined \{ … \}$/m);
    assert.ok(!out.includes("fetch("), "bodies are gone");
    assert.ok(!out.includes("import"), "imports are dropped");
    assert.ok(!out.includes("block"), "comments are dropped");
  });

  it("handles Kotlin classes and objects", () => {
    const out = packSignatures(KOTLIN);
    assert.match(out, /^data class Money\(val cents: Long\) \{$/m);
    assert.match(out, /^ {2}fun isZero\(\): Boolean \{ … \}$/m);
    assert.match(out, /^object Registry \{\n {2}fun add\(s: String\) \{ … \}\n\}$/m);
  });

  it("stops at maxChars", () => {
    const big = `class Big {\n${Array.from({ length: 500 }, (_, i) => `  void m${i}() { }`).join("\n")}\n}`;
    const out = packSignatures(big, { maxChars: 300 });
    assert.ok(out.length < 400);
    assert.match(out, /\[\.\.\. rest of file omitted\]$/);
  });
});
