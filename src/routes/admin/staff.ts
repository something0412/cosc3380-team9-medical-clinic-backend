import { Router } from "express";
import type { Request } from "express";
import { z } from "zod";
import { pool } from "../../lib/db.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { createEmployee, doctorLicenseSchema, employeeSchema, listEmployees, passwordSchema, setEmployeeStatus, updateEmployee } from "../../services/employees.js";

// the Staff page's shorter forms, saved through the same employee rules as the employee pages
export const adminStaffRouter = Router();

const idParam = z.coerce.number().int().positive();

const listQuery = z.object({
  status: z.enum(["active", "inactive", "all"], "Status must be active, inactive or all").default("active"),
  role: z.string().trim().default("all"),
});

// this form picks one specialty, which becomes the primary one
const newStaffSchema = employeeSchema.omit({ doctor: true }).extend({
  password: passwordSchema,
  doctor: doctorLicenseSchema.extend({ specialtyId: z.number("Select a specialty").int().positive() }).nullish(),
});

const staffChanges = employeeSchema.pick({ firstName: true, lastName: true, phone: true, email: true, officeId: true });

function adminId(req: Request) {
  if (req.user?.role !== "admin") throw new HttpError(401, "Login required");
  return req.user.employeeId;
}

adminStaffRouter.get("/", async (req, res) => {
  const { status, role } = listQuery.parse(req.query);
  const staff = await listEmployees({ status, employeeType: role });
  const byName = (a: (typeof staff)[number], b: (typeof staff)[number]) =>
    a.employeeType.localeCompare(b.employeeType) || a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName);
  res.json(staff.sort(byName).map((e) => ({ ...e, role: e.employeeType })));
});

// roles, offices, and specialties for the staff form
adminStaffRouter.get("/options", async (_req, res) => {
  const roles = await pool.query(`
    SELECT employee_type_id AS "employeeTypeId", type_name AS name
    FROM employee_types
    WHERE is_active
    ORDER BY type_name
  `);

  const offices = await pool.query(`
    SELECT office_id AS "officeId", name
    FROM office
    WHERE is_active
    ORDER BY name
  `);

  const specialties = await pool.query(`
    SELECT specialty_id AS "specialtyId", name
    FROM specialty
    WHERE is_active
    ORDER BY name
  `);

  res.json({ roles: roles.rows, offices: offices.rows, specialties: specialties.rows });
});

function withSpecialty(doctor: z.infer<typeof newStaffSchema>["doctor"]) {
  if (!doctor) return doctor;
  const { specialtyId, ...license } = doctor;
  return { ...license, specialtyIds: [specialtyId], primarySpecialtyId: specialtyId };
}

// the email is used as the login username here
adminStaffRouter.post("/", async (req, res) => {
  const { password, doctor, ...fields } = newStaffSchema.parse(req.body);
  res.status(201).json(await createEmployee({ ...fields, doctor: withSpecialty(doctor), login: { username: fields.email, password } }));
});

adminStaffRouter.put("/:id", async (req, res) => {
  const employeeId = idParam.parse(req.params.id);
  res.json(await updateEmployee(employeeId, staffChanges.parse(req.body)));
});

// activate or deactivate an employee, with the same rules as the employee pages
adminStaffRouter.patch("/:id/status", async (req, res) => {
  const employeeId = idParam.parse(req.params.id);
  const { isActive } = z.object({ isActive: z.boolean("Status must be true or false") }).parse(req.body);
  res.json(await setEmployeeStatus(employeeId, isActive, adminId(req)));
});
