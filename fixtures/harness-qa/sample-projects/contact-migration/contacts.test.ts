import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addContact, openContacts, readLegacyContacts } from "./contacts";

test("legacy readers preserve names, order and quoted input", () => {
  const database = openContacts(":memory:");
  try {
    addContact(database, "Ada");
    addContact(database, "O'Connor");
    expect(readLegacyContacts(database)).toEqual([
      { id: 1, display_name: "Ada" }, { id: 2, display_name: "O'Connor" },
    ]);
  } finally { database.close(); }
});

test("empty names are rejected without a write", () => {
  const database = openContacts(":memory:");
  try {
    expect(() => addContact(database, "  ")).toThrow("Contact name is required");
    expect(readLegacyContacts(database)).toEqual([]);
  } finally { database.close(); }
});

test("opening an existing file preserves legacy records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "foundry-contact-baseline-"));
  const path = join(directory, "contacts.sqlite");
  let database: ReturnType<typeof openContacts> | undefined;
  try {
    database = openContacts(path);
    addContact(database, "Ada");
    database.close(); database = undefined;
    database = openContacts(path);
    expect(readLegacyContacts(database)).toEqual([{ id: 1, display_name: "Ada" }]);
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
