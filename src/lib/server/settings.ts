import "server-only";
import { sql } from "./db";

export async function getSetting<T>(key: string): Promise<T | null> {
  const rows = (await sql`select value from settings where key = ${key}`) as { value: T }[];
  return rows[0]?.value ?? null;
}

export async function setSetting(key: string, value: unknown) {
  await sql`insert into settings (key, value) values (${key}, ${JSON.stringify(value)})
    on conflict (key) do update set value = excluded.value, updated_at = now()`;
}
