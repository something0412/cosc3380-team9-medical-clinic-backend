import { Router } from "express";
import type { Request } from "express";
import { z } from "zod";
import { HttpError } from "../../middleware/errorHandler.js";
import {
  addLogin,
  createEmployee,
  employeeSchema,
  getEmployee,
  listEmployees,
  loginSchema,
  newEmployeeSchema,
  passwordSchema,
  setEmployeeStatus,
  setLoginStatus,
  setPassword,
  updateEmployee,
} from "../../services/employees.js";

export const adminEmployeesRouter = Router();

const idParam = z.coerce.number().int().positive();
const listQuery = z.object({
  status: z.enum(["active", "inactive", "all"], "Status must be active, inactive or all").default("all"),
  type: z.string().trim().default("all"),
});

// the signed in admin, used so they can't lock themselves out
function adminId(req: Request) {
  if (req.user?.role !== "admin") throw new HttpError(401, "Login required");
  return req.user.employeeId;
}

adminEmployeesRouter.get("/", async (req, res) => {
  const { status, type } = listQuery.parse(req.query);
  res.json(await listEmployees({ status, employeeType: type }));
});

adminEmployeesRouter.get("/:id", async (req, res) => {
  const employee = await getEmployee(idParam.parse(req.params.id));
  if (!employee) throw new HttpError(404, "Employee not found");
  res.json(employee);
});

// create an employee with optional login and doctor/nurse details
adminEmployeesRouter.post("/", async (req, res) => {
  res.status(201).json(await createEmployee(newEmployeeSchema.parse(req.body)));
});

// update employee info. Login and active status are managed separately
adminEmployeesRouter.put("/:id", async (req, res) => {
  const employeeId = idParam.parse(req.params.id);
  res.json(await updateEmployee(employeeId, employeeSchema.parse(req.body)));
});

// activate or deactivate an employee and leave their login record as is
adminEmployeesRouter.patch("/:id/status", async (req, res) => {
  const employeeId = idParam.parse(req.params.id);
  const { isActive } = z.object({ isActive: z.boolean("Status must be true or false") }).parse(req.body);
  res.json(await setEmployeeStatus(employeeId, isActive, adminId(req)));
});

// enable or disable an existing login without changing the password
adminEmployeesRouter.patch("/:id/login-status", async (req, res) => {
  const employeeId = idParam.parse(req.params.id);
  const { loginActive } = z.object({ loginActive: z.boolean("Login status must be true or false") }).parse(req.body);
  res.json(await setLoginStatus(employeeId, loginActive, adminId(req)));
});

// set a new password for an existing login without changing its status
adminEmployeesRouter.put("/:id/password", async (req, res) => {
  const employeeId = idParam.parse(req.params.id);
  const { password } = z.object({ password: passwordSchema }).parse(req.body);
  await setPassword(employeeId, password);
  res.status(204).end();
});

// add a login for an employee who doesn't have one
adminEmployeesRouter.post("/:id/login", async (req, res) => {
  const employeeId = idParam.parse(req.params.id);
  res.status(201).json(await addLogin(employeeId, loginSchema.parse(req.body)));
});
