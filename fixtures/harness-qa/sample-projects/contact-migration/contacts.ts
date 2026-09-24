import { Database } from "bun:sqlite";

export interface LegacyContact { id: number; display_name: string }

export function openContacts(path: string): Database {
  const database = new Database(path);
  try {
    database.exec("CREATE TABLE IF NOT EXISTS contacts (id INTEGER PRIMARY KEY, display_name TEXT NOT NULL)");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function addContact(database: Database, name: string): void {
  if (!name.trim()) throw new Error("Contact name is required");
  database.query("INSERT INTO contacts(display_name) VALUES (?)").run(name);
}

export function readLegacyContacts(database: Database): LegacyContact[] {
  return database.query("SELECT id, display_name FROM contacts ORDER BY id").all() as LegacyContact[];
}
