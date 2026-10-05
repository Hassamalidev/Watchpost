/* Zod request schemas, built from @app/shared. */
import { z } from "zod";
import { createMaintenanceWindowSchema, updateMaintenanceWindowSchema } from "@app/shared";

export const windowIdParams = z.object({ windowId: z.uuid() });
export const createWindowBody = createMaintenanceWindowSchema;
export const updateWindowBody = updateMaintenanceWindowSchema;
