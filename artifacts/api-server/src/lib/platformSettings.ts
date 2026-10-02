import { eq } from "drizzle-orm";
import { db, platformSettingsTable } from "@workspace/db";

export async function getOrCreatePlatformSettings() {
  await db
    .insert(platformSettingsTable)
    .values({ id: "default" })
    .onConflictDoNothing({ target: platformSettingsTable.id });
  const [settings] = await db
    .select()
    .from(platformSettingsTable)
    .where(eq(platformSettingsTable.id, "default"))
    .limit(1);
  if (!settings) throw new Error("Platform settings could not be loaded.");
  return settings;
}