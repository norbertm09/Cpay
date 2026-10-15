'use strict';

const crypto = require('crypto');
const { query, withTransaction } = require('../../config/database');

const VALID_STATUS = ['open', 'pending_admin', 'pending_merchant', 'resolved', 'closed'];
const VALID_PRIORITY = ['low', 'normal', 'high', 'urgent'];
const VALID_CATEGORY = ['general', 'payment', 'settlement', 'api', 'kyb', 'terminal', 'technical'];

const clean = (value, max) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
};

const nextTicketNumber = () => {
  const stamp = new Date().toISOString().slice(2, 10).replace(/-/g, '');
  return `CP-${stamp}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
};

const listMerchantTickets = async ({ merchantId, status, page = 1, limit = 25 }) => {
  const params = [merchantId];
  let where = 'WHERE t.merchant_id = $1';
  if (status) {
    params.push(status);
    where += ` AND t.status = $${params.length}`;
  }
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);
  const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * safeLimit;
  params.push(safeLimit, offset);

  const [data, count] = await Promise.all([
    query(
      `SELECT t.*, m.business_name,
              (SELECT message FROM support_ticket_messages sm WHERE sm.ticket_id = t.ticket_id ORDER BY sm.created_at DESC LIMIT 1) AS last_message
       FROM support_tickets t JOIN merchants m ON m.merchant_id = t.merchant_id
       ${where}
       ORDER BY t.last_message_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    ),
    query(`SELECT COUNT(*) FROM support_tickets t ${where}`, params.slice(0, -2)),
  ]);

  return { data: data.rows, total: parseInt(count.rows[0].count, 10), page: parseInt(page, 10) || 1, limit: safeLimit };
};

const listAdminTickets = async ({ status, priority, merchantId, search, page = 1, limit = 50 }) => {
  const params = [];
  let where = 'WHERE 1=1';
  if (status) { params.push(status); where += ` AND t.status = $${params.length}`; }
  if (priority) { params.push(priority); where += ` AND t.priority = $${params.length}`; }
  if (merchantId) { params.push(merchantId); where += ` AND t.merchant_id = $${params.length}`; }
  if (search) {
    params.push(`%${search}%`);
    where += ` AND (t.ticket_number ILIKE $${params.length} OR t.subject ILIKE $${params.length} OR m.business_name ILIKE $${params.length})`;
  }
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
  const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * safeLimit;
  params.push(safeLimit, offset);

  const [data, count] = await Promise.all([
    query(
      `SELECT t.*, m.business_name, m.country, m.email AS merchant_email,
              (SELECT message FROM support_ticket_messages sm WHERE sm.ticket_id = t.ticket_id ORDER BY sm.created_at DESC LIMIT 1) AS last_message
       FROM support_tickets t JOIN merchants m ON m.merchant_id = t.merchant_id
       ${where}
       ORDER BY
         CASE t.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
         t.last_message_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    ),
    query(`SELECT COUNT(*) FROM support_tickets t JOIN merchants m ON m.merchant_id = t.merchant_id ${where}`, params.slice(0, -2)),
  ]);

  return { data: data.rows, total: parseInt(count.rows[0].count, 10), page: parseInt(page, 10) || 1, limit: safeLimit };
};

const getTicket = async ({ ticketId, merchantId }) => {
  return getTicketUsing(query, { ticketId, merchantId });
};

const getTicketUsing = async (dbQuery, { ticketId, merchantId }) => {
  const params = [ticketId];
  let where = 'WHERE t.ticket_id = $1';
  if (merchantId) {
    params.push(merchantId);
    where += ` AND t.merchant_id = $${params.length}`;
  }

  const ticket = await dbQuery(
    `SELECT t.*, m.business_name, m.country, m.email AS merchant_email
     FROM support_tickets t JOIN merchants m ON m.merchant_id = t.merchant_id
     ${where}`,
    params
  );
  if (!ticket.rows.length) return null;

  const messages = await dbQuery(
    `SELECT message_id, sender_type, sender_id, sender_name, message, attachments, is_internal, created_at
     FROM support_ticket_messages
     WHERE ticket_id = $1
     ORDER BY created_at ASC`,
    [ticket.rows[0].ticket_id]
  );

  return { ...ticket.rows[0], messages: messages.rows };
};

const createTicket = async ({ merchantId, userId, subject, category = 'general', priority = 'normal', message, senderName }) => {
  const cleanSubject = clean(subject, 180);
  const cleanMessage = clean(message, 5000);
  const cleanCategory = VALID_CATEGORY.includes(category) ? category : 'general';
  const cleanPriority = VALID_PRIORITY.includes(priority) ? priority : 'normal';
  if (!cleanSubject || !cleanMessage) {
    const err = new Error('subject et message requis');
    err.statusCode = 422;
    err.code = 'INVALID_TICKET';
    throw err;
  }

  return withTransaction(async (client) => {
    const created = await client.query(
      `INSERT INTO support_tickets (ticket_number, merchant_id, created_by_user, subject, category, priority, status)
       VALUES ($1,$2,$3,$4,$5,$6,'pending_admin')
       RETURNING *`,
      [nextTicketNumber(), merchantId, userId, cleanSubject, cleanCategory, cleanPriority]
    );
    await client.query(
      `INSERT INTO support_ticket_messages (ticket_id, sender_type, sender_id, sender_name, message)
       VALUES ($1,'merchant',$2,$3,$4)`,
      [created.rows[0].ticket_id, userId, senderName || 'Marchand', cleanMessage]
    );
    return getTicketUsing(client.query.bind(client), { ticketId: created.rows[0].ticket_id, merchantId });
  });
};

const addMessage = async ({ ticketId, merchantId, senderType, senderId, senderName, message, isInternal = false }) => {
  const cleanMessage = clean(message, 5000);
  if (!cleanMessage) {
    const err = new Error('message requis');
    err.statusCode = 422;
    err.code = 'INVALID_MESSAGE';
    throw err;
  }

  return withTransaction(async (client) => {
    const params = [ticketId];
    let where = 'WHERE ticket_id = $1';
    if (merchantId) {
      params.push(merchantId);
      where += ` AND merchant_id = $${params.length}`;
    }
    const ticket = await client.query(`SELECT * FROM support_tickets ${where} FOR UPDATE`, params);
    if (!ticket.rows.length) {
      const err = new Error('Ticket introuvable');
      err.statusCode = 404;
      err.code = 'TICKET_NOT_FOUND';
      throw err;
    }

    await client.query(
      `INSERT INTO support_ticket_messages (ticket_id, sender_type, sender_id, sender_name, message, is_internal)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [ticketId, senderType, senderId, senderName || senderType, cleanMessage, !!isInternal]
    );

    const nextStatus = senderType === 'admin' ? 'pending_merchant' : 'pending_admin';
    await client.query(
      `UPDATE support_tickets
       SET status = CASE WHEN status IN ('resolved','closed') THEN 'open'::support_ticket_status ELSE $1::support_ticket_status END,
           last_message_at = NOW(), updated_at = NOW()
       WHERE ticket_id = $2`,
      [nextStatus, ticketId]
    );

    return getTicketUsing(client.query.bind(client), { ticketId, merchantId });
  });
};

const updateTicket = async ({ ticketId, status, priority, assignedAdminId }) => {
  if (status && !VALID_STATUS.includes(status)) {
    const err = new Error('Statut ticket invalide');
    err.statusCode = 422;
    throw err;
  }
  if (priority && !VALID_PRIORITY.includes(priority)) {
    const err = new Error('Priorite ticket invalide');
    err.statusCode = 422;
    throw err;
  }

  const result = await query(
    `UPDATE support_tickets SET
       status = COALESCE($1::support_ticket_status, status),
       priority = COALESCE($2::support_ticket_priority, priority),
       assigned_admin_id = COALESCE($3, assigned_admin_id),
       resolved_at = CASE WHEN $1 = 'resolved' THEN NOW() ELSE resolved_at END,
       closed_at = CASE WHEN $1 = 'closed' THEN NOW() ELSE closed_at END,
       updated_at = NOW()
     WHERE ticket_id = $4
     RETURNING *`,
    [status || null, priority || null, assignedAdminId || null, ticketId]
  );
  if (!result.rows.length) return null;
  return getTicket({ ticketId });
};

module.exports = {
  listMerchantTickets,
  listAdminTickets,
  getTicket,
  createTicket,
  addMessage,
  updateTicket,
};
