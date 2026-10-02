import { Router, type IRouter } from "express";
import healthRouter from "./health";
import adminRouter from "./admin";
import financeRouter from "./finance";
import platformRouter from "./platform";

const router: IRouter = Router();

router.use(healthRouter);
router.use(platformRouter);
router.use(financeRouter);
router.use(adminRouter);

export default router;
