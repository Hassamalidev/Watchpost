import { z } from "zod";
import { MONITOR_STATUSES } from "../constants/product.js";

export const monitorStatusSchema = z.enum(MONITOR_STATUSES);
