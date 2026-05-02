import { Router, type IRouter } from "express";
import healthRouter from "./health";
import statusRouter from "./status";
import adminRouter from "./admin";

const router: IRouter = Router();

router.use(healthRouter);
router.use(statusRouter);
router.use("/admin", adminRouter);

export default router;
