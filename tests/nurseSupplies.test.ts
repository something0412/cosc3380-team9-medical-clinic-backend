import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { addEmployee, addLogin, addNurse, dayFrom, waitForLockWait } from "./helpers/appointmentData.js";
import { failWrites, slowWrites } from "./helpers/dbFaults.js";
import { startTestApp } from "./helpers/testApp.js";
import type { TestClient, TestResponse } from "./helpers/testApp.js";
import { ids, resetDatabase } from "./helpers/testDb.js";

let app: Awaited<ReturnType<typeof startTestApp>>;
let today: string;
let nina: TestClient, nell: TestClient, omar: TestClient, ivy: TestClient;
let nellId: number;
const supply: Record<string, number> = {};
const stock: Record<string, number> = {};

const statuses = (responses: TestResponse[]) => responses.map((r) => r.status).sort();
const onHand = async (officeSupplyId: number) =>
  (await app.db.query(`SELECT quantity_on_hand AS n FROM office_supply WHERE office_supply_id = $1`, [officeSupplyId])).rows[0].n as number;

async function addStock(supplyId: number, officeId: number, quantity: number, threshold: number, opts: { expires?: string; isActive?: boolean } = {}) {
  const { rows } = await app.db.query(
    `INSERT INTO office_supply (supply_id, office_id, quantity_on_hand, reorder_threshold, expiration_date, is_active) VALUES ($1, $2, $3, $4, $5, $6) RETURNING office_supply_id AS id`,
    [supplyId, officeId, quantity, threshold, opts.expires ?? null, opts.isActive ?? true]
  );
  return rows[0].id as number;
}

async function addSupply(name: string, typeId: number, isActive = true) {
  return (await app.db.query(`INSERT INTO supply (name, supply_type_id, is_active) VALUES ($1, $2, $3) RETURNING supply_id AS id`, [name, typeId, isActive])).rows[0].id as number;
}

const use = (client: TestClient, officeSupplyId: number, quantity: unknown) => client.patch(`/api/nurse/supplies/${officeSupplyId}/use`, { quantity });
const order = (client: TestClient, body: object) => client.post("/api/nurse/supply-orders", body);

// holds a change open in its own transaction while a request waits on it
async function whileHeld(change: string, params: unknown[], send: () => Promise<TestResponse>) {
  const held = await app.db.connect();
  try {
    await held.query("BEGIN");
    await held.query(change, params);
    const waiting = send();
    await waitForLockWait(app.db);
    await held.query("COMMIT");
    return await waiting;
  } catch (err) {
    await held.query("ROLLBACK");
    throw err;
  } finally {
    held.release();
  }
}

before(async () => {
  await resetDatabase();
  app = await startTestApp();
  today = (await app.db.query(`SELECT to_char((now() AT TIME ZONE 'America/Chicago')::date, 'YYYY-MM-DD') AS d`)).rows[0].d;

  const types = await app.db.query(`INSERT INTO supply_type (type_name) VALUES ('Medical'), ('Cleaning') RETURNING supply_type_id AS id`);
  const [medical, cleaning] = types.rows.map((r) => r.id as number);
  supply.gauze = await addSupply("Gauze", medical);
  supply.gloves = await addSupply("Gloves", medical);
  supply.syringes = await addSupply("Syringes", medical);
  supply.wipes = await addSupply("Wipes", cleaning);
  supply.masks = await addSupply("Masks", medical);
  supply.retired = await addSupply("Old Tape", medical, false);

  // Nina and Nell work at Westside, Omar at Main Street, and Ivy's office has no stock
  stock.gauze = await addStock(supply.gauze, ids.westsideOffice, 10, 5);
  stock.gloves = await addStock(supply.gloves, ids.westsideOffice, 3, 5);
  stock.syringes = await addStock(supply.syringes, ids.westsideOffice, 50, 10, { expires: dayFrom(today, 10) });
  stock.masksOff = await addStock(supply.masks, ids.westsideOffice, 4, 0, { isActive: false });
  stock.retired = await addStock(supply.retired, ids.westsideOffice, 8, 0);
  stock.mainGauze = await addStock(supply.gauze, ids.mainOffice, 100, 20);

  nellId = await addNurse(app.db, "Nell", ids.westsideOffice);
  nina = await app.loginStaff(ids.nurse);
  nell = await app.loginStaff(nellId);
  omar = await app.loginStaff(await addNurse(app.db, "Omar", ids.mainOffice));
  ivy = await app.loginStaff(await addNurse(app.db, "Ivy", ids.closedOffice));
});

after(async () => {
  await app.close();
});

describe("reading supplies", () => {
  test("a nurse sees their own office's active stock, low items first, with expiry and amount on order", async () => {
    await app.db.query(`INSERT INTO supply_order (supply_id, office_id, employee_id, quantity_ordered, status) VALUES ($1, $2, $3, 6, 'Ordered'), ($1, $2, $3, 9, 'Received')`, [
      supply.gauze,
      ids.westsideOffice,
      ids.nurse,
    ]);
    const res = await nina.get("/api/nurse/supplies");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.map((s: { name: string }) => s.name), ["Gloves", "Gauze", "Syringes"]);
    assert.deepEqual(res.body[0], {
      officeSupplyId: stock.gloves,
      supplyId: supply.gloves,
      name: "Gloves",
      supplyType: "Medical",
      officeId: ids.westsideOffice,
      quantityOnHand: 3,
      reorderThreshold: 5,
      expirationDate: null,
      lowStock: true,
      expiringSoon: false,
      onOrder: 0,
    });
    const gauze = res.body.find((s: { name: string }) => s.name === "Gauze");
    const syringes = res.body.find((s: { name: string }) => s.name === "Syringes");
    assert.deepEqual([gauze.onOrder, gauze.lowStock, syringes.expirationDate, syringes.expiringSoon], [6, false, dayFrom(today, 10), true]);

    assert.deepEqual((await omar.get("/api/nurse/supplies")).body.map((s: { officeSupplyId: number }) => s.officeSupplyId), [stock.mainGauze]);
    assert.deepEqual((await ivy.get("/api/nurse/supplies")).body, []);
    await app.db.query(`DELETE FROM supply_order`);
  });

  test("the order dropdown lists active supplies with their type, by name", async () => {
    const res = await nina.get("/api/nurse/supply-list");
    assert.deepEqual(
      res.body.map((s: { name: string; supplyType: string }) => `${s.name} ${s.supplyType}`),
      ["Gauze Medical", "Gloves Medical", "Masks Medical", "Syringes Medical", "Wipes Cleaning"]
    );
    assert.deepEqual(Object.keys(res.body[0]), ["supplyId", "name", "supplyTypeId", "supplyType"]);
  });
});

describe("using supplies", () => {
  test("using stock takes it out only when there's enough, and bad requests change nothing", async () => {
    const used = await use(nina, stock.gauze, 4);
    assert.deepEqual([used.status, used.body.quantityOnHand, used.body.officeSupplyId], [200, 6, stock.gauze]);
    assert.equal((await use(nina, stock.gauze, "1")).body.quantityOnHand, 5);

    const short = await use(nina, stock.gauze, 6);
    assert.deepEqual([short.status, short.body.error], [409, "Not enough in stock at your office. Only 5 left."]);
    for (const quantity of [0, -1, 1.5, "abc", null, 3000000000]) {
      assert.equal((await use(nina, stock.gauze, quantity)).status, 400, String(quantity));
    }
    assert.equal((await nina.patch(`/api/nurse/supplies/${stock.gauze}/use`, {})).status, 400);
    for (const id of [stock.mainGauze, stock.masksOff, 999999]) {
      assert.deepEqual((await use(nina, id, 1)).body, { error: "Supply not found at your office" }, String(id));
    }
    assert.equal((await nina.patch("/api/nurse/supplies/abc/use", { quantity: 1 })).status, 400);
    assert.deepEqual([await onHand(stock.gauze), await onHand(stock.mainGauze), await onHand(stock.masksOff)], [5, 100, 4]);

    // using every last one is allowed
    assert.equal((await use(nina, stock.gloves, 3)).body.quantityOnHand, 0);
    assert.equal((await use(nina, stock.gloves, 1)).status, 409);
  });

  test("two nurses using the same stock at once can't take more than there is", async () => {
    const shared = await addStock(supply.wipes, ids.westsideOffice, 10, 0);
    const other = stock.syringes;
    const otherBefore = await onHand(other);
    const restore = await slowWrites(app.db, "office_supply", "UPDATE");
    try {
      assert.deepEqual(statuses(await Promise.all([use(nina, shared, 7), use(nell, shared, 7)])), [200, 409]);
      assert.equal(await onHand(shared), 3);
      assert.deepEqual(statuses(await Promise.all([use(nina, shared, 1), use(nell, shared, 2)])), [200, 200]);
      assert.equal(await onHand(shared), 0);
      assert.deepEqual(statuses(await Promise.all([use(nina, other, 5), use(nell, other, 5)])), [200, 200]);
    } finally {
      await restore();
    }
    assert.equal(await onHand(other), otherBefore - 10);
  });
});

describe("supply orders", () => {
  test("a nurse orders for their own office, and the list shows open orders first", async () => {
    const created = await order(nina, { supplyId: supply.gauze, quantity: 20, officeId: ids.mainOffice, employeeId: ids.admin });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual(
      [created.body.status, created.body.officeId, created.body.orderedById, created.body.orderedBy, created.body.orderDate, created.body.quantityOrdered, created.body.supplyName],
      ["Pending", ids.westsideOffice, ids.nurse, "Nina Nurse", today, 20, "Gauze"]
    );
    const done = await order(nell, { supplyId: supply.gloves, quantity: 5 });
    await nell.patch(`/api/nurse/supply-orders/${done.body.supplyOrderId}/cancel`);
    const later = await order(nell, { supplyId: supply.wipes, quantity: 2 });

    const list = (await nina.get("/api/nurse/supply-orders")).body.map((o: { supplyOrderId: number }) => o.supplyOrderId);
    assert.deepEqual(list.slice(0, 3), [later.body.supplyOrderId, created.body.supplyOrderId, done.body.supplyOrderId]);
    assert.equal((await omar.get("/api/nurse/supply-orders")).body.some((o: { officeId: number }) => o.officeId !== ids.mainOffice), false);
    assert.deepEqual((await ivy.get("/api/nurse/supply-orders")).body, []);

    const before = (await app.db.query(`SELECT count(*)::int AS n FROM supply_order`)).rows[0].n;
    for (const body of [{ supplyId: supply.retired, quantity: 1 }, { supplyId: 999999, quantity: 1 }, { supplyId: supply.gauze, quantity: 0 }, { quantity: 1 }, { supplyId: supply.gauze }]) {
      assert.equal((await order(nina, body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await app.db.query(`SELECT count(*)::int AS n FROM supply_order`)).rows[0].n, before);
  });

  test("receiving an order adds it to stock once, and only open orders at my office can be received or cancelled", async () => {
    const gauzeBefore = await onHand(stock.gauze);
    const gauze = (await order(nina, { supplyId: supply.gauze, quantity: 12 })).body;
    const received = await nina.patch(`/api/nurse/supply-orders/${gauze.supplyOrderId}/receive`);
    assert.deepEqual([received.status, received.body.status, received.body.stock.officeSupplyId, received.body.stock.quantityOnHand], [200, "Received", stock.gauze, gauzeBefore + 12]);

    const again = await nina.patch(`/api/nurse/supply-orders/${gauze.supplyOrderId}/receive`);
    assert.deepEqual([again.status, again.body.error], [409, "Only open orders for your office can be received. This one is Received."]);
    assert.equal((await nina.patch(`/api/nurse/supply-orders/${gauze.supplyOrderId}/cancel`)).status, 409);
    assert.equal(await onHand(stock.gauze), gauzeBefore + 12);

    // a supply the office didn't stock gets a new row, and a stock row that was turned off comes back
    const fresh = (await order(omar, { supplyId: supply.syringes, quantity: 30 })).body;
    const freshStock = (await omar.patch(`/api/nurse/supply-orders/${fresh.supplyOrderId}/receive`)).body.stock;
    assert.deepEqual([freshStock.officeId, freshStock.quantityOnHand, freshStock.reorderThreshold], [ids.mainOffice, 30, 0]);
    const masks = (await order(nina, { supplyId: supply.masks, quantity: 6 })).body;
    assert.deepEqual((await nina.patch(`/api/nurse/supply-orders/${masks.supplyOrderId}/receive`)).body.stock.officeSupplyId, stock.masksOff);
    assert.equal(await onHand(stock.masksOff), 10);
    assert.ok((await nina.get("/api/nurse/supplies")).body.some((s: { officeSupplyId: number }) => s.officeSupplyId === stock.masksOff), "back on the list");

    const open = (await order(nina, { supplyId: supply.gloves, quantity: 4 })).body;
    assert.deepEqual((await omar.patch(`/api/nurse/supply-orders/${open.supplyOrderId}/receive`)).body, { error: "Supply order not found at your office" });
    assert.equal((await omar.patch(`/api/nurse/supply-orders/${open.supplyOrderId}/cancel`)).status, 404);
    assert.equal((await nina.patch("/api/nurse/supply-orders/999999/cancel")).status, 404);
    const cancelled = await nell.patch(`/api/nurse/supply-orders/${open.supplyOrderId}/cancel`);
    assert.deepEqual([cancelled.status, cancelled.body.status], [200, "Cancelled"]);
    assert.equal((await nina.patch(`/api/nurse/supply-orders/${open.supplyOrderId}/receive`)).body.error, "Only open orders for your office can be received. This one is Cancelled.");
  });

  test("receiving the same order twice at once, or while stock is being used, keeps the count right", async () => {
    const before = await onHand(stock.syringes);
    const twice = (await order(nina, { supplyId: supply.syringes, quantity: 10 })).body;
    let restore = await slowWrites(app.db, "supply_order", "UPDATE");
    try {
      const both = await Promise.all([
        nina.patch(`/api/nurse/supply-orders/${twice.supplyOrderId}/receive`),
        nell.patch(`/api/nurse/supply-orders/${twice.supplyOrderId}/receive`),
      ]);
      assert.deepEqual(statuses(both), [200, 409]);
    } finally {
      await restore();
    }
    assert.equal(await onHand(stock.syringes), before + 10);

    const more = (await order(nina, { supplyId: supply.syringes, quantity: 5 })).body;
    restore = await slowWrites(app.db, "office_supply", "UPDATE");
    try {
      const mixed = await Promise.all([nina.patch(`/api/nurse/supply-orders/${more.supplyOrderId}/receive`), use(nell, stock.syringes, 3)]);
      assert.deepEqual(statuses(mixed), [200, 200]);
    } finally {
      await restore();
    }
    assert.equal(await onHand(stock.syringes), before + 10 + 5 - 3);
  });

  test("a receive that can't save the stock leaves the order open", async () => {
    const pending = (await order(nina, { supplyId: supply.wipes, quantity: 8 })).body;
    const before = await onHand(stock.gauze);
    const wipesBefore = (await app.db.query(`SELECT quantity_on_hand AS n FROM office_supply WHERE supply_id = $1 AND office_id = $2`, [supply.wipes, ids.westsideOffice])).rows[0].n;
    const restore = await failWrites(app.db, "office_supply", "INSERT");
    try {
      assert.equal((await nina.patch(`/api/nurse/supply-orders/${pending.supplyOrderId}/receive`)).status, 400);
    } finally {
      await restore();
    }
    assert.equal((await app.db.query(`SELECT status FROM supply_order WHERE supply_order_id = $1`, [pending.supplyOrderId])).rows[0].status, "Pending");
    assert.equal((await app.db.query(`SELECT quantity_on_hand AS n FROM office_supply WHERE supply_id = $1 AND office_id = $2`, [supply.wipes, ids.westsideOffice])).rows[0].n, wipesBefore);
    assert.equal(await onHand(stock.gauze), before);
  });
});

describe("who can use the supply pages", () => {
  test("only nurses reach the supply routes, and nothing changes for anyone else", async () => {
    const labType = (await app.db.query(`INSERT INTO employee_types (type_name) VALUES ('Lab Technician') RETURNING employee_type_id AS id`)).rows[0].id;
    await addLogin(app.db, ids.receptionist);
    const pending = (await order(nina, { supplyId: supply.gauze, quantity: 1 })).body;
    const clients: [string, TestClient, number][] = [
      ["signed out", app.client(), 401],
      ["patient", await app.loginPatient(ids.patient, "pat@test.org"), 403],
      ["doctor", await app.loginStaff(ids.doctor), 403],
      ["receptionist", await app.loginStaff(ids.receptionist), 403],
      ["lab", await app.loginStaff(await addEmployee(app.db, "Lee", labType, ids.westsideOffice)), 403],
      ["admin", await app.loginStaff(ids.admin), 403],
    ];
    const before = [await onHand(stock.gauze), (await app.db.query(`SELECT count(*)::int AS n FROM supply_order`)).rows[0].n];
    for (const [name, client, status] of clients) {
      const tries = [
        client.get("/api/nurse/supplies"),
        use(client, stock.gauze, 1),
        client.get("/api/nurse/supply-list"),
        client.get("/api/nurse/supply-orders"),
        order(client, { supplyId: supply.gauze, quantity: 1 }),
        client.patch(`/api/nurse/supply-orders/${pending.supplyOrderId}/receive`),
        client.patch(`/api/nurse/supply-orders/${pending.supplyOrderId}/cancel`),
      ];
      for (const res of await Promise.all(tries)) assert.equal(res.status, status, `${name} got ${res.status}`);
    }
    assert.deepEqual([await onHand(stock.gauze), (await app.db.query(`SELECT count(*)::int AS n FROM supply_order`)).rows[0].n], before);
    assert.equal((await app.db.query(`SELECT status FROM supply_order WHERE supply_order_id = $1`, [pending.supplyOrderId])).rows[0].status, "Pending");
  });

  test("a moved or deactivated nurse works with their new office or loses access, even mid request", async () => {
    const before = await onHand(stock.gauze);
    const moved = await whileHeld(`UPDATE employee SET office_id = $2 WHERE employee_id = $1`, [nellId, ids.mainOffice], () => use(nell, stock.gauze, 1));
    assert.deepEqual([moved.status, moved.body.error], [404, "Supply not found at your office"]);
    assert.deepEqual((await nell.get("/api/nurse/supplies")).body.map((s: { officeId: number }) => s.officeId), [ids.mainOffice, ids.mainOffice]);
    await app.db.query(`UPDATE employee SET office_id = $2 WHERE employee_id = $1`, [nellId, ids.westsideOffice]);

    const stopped = await whileHeld(`UPDATE employee SET is_active = false WHERE employee_id = $1`, [nellId], () => use(nell, stock.gauze, 1));
    assert.deepEqual([stopped.status, stopped.body.error], [403, "Your account is no longer active"]);
    assert.equal((await nell.get("/api/nurse/supplies")).status, 401);
    assert.equal(await onHand(stock.gauze), before);
    await app.db.query(`UPDATE employee SET is_active = true WHERE employee_id = $1`, [nellId]);
  });
});
