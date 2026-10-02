import { Router, type IRouter } from "express";
import { GetPlatformSettingsResponse } from "@workspace/api-zod";
import { getOrCreatePlatformSettings } from "../lib/platformSettings";

const router: IRouter = Router();

router.get("/platform-settings", async (_req, res): Promise<void> => {
  const settings = await getOrCreatePlatformSettings();
  res.json(GetPlatformSettingsResponse.parse(settings));
});

export default router;