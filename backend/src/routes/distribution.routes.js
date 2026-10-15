'use strict';
const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { query, withTransaction } = require('../config/database');

const makeAuth = (roles) => async (req, res, next) => {
  try {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token requis' });
    const d = jwt.verify(h.slice(7), process.env.JWT_SECRET);
    if (!roles.includes(d.role)) return res.status(403).json({ error: 'Accès refusé' });
    req.user = d; next();
  } catch { res.status(401).json({ error: 'Token invalide' }); }
};

const adminAuth   = makeAuth(['admin']);
const bankAuth    = makeAuth(['bank_admin']);
const agencyAuth  = makeAuth(['agency_admin']);
const agentAuth   = makeAuth(['agent']);

const adminRouter      = express.Router();
const bankRouter       = express.Router();
const agencyRouter     = express.Router();
const agentPortalRouter = express.Router();

// Admin — banques
adminRouter.get('/banks',  adminAuth, async (req, res) => { const r = await query(`SELECT * FROM distribution_banks ORDER BY bank_name`); res.json({ data: r.rows }); });
adminRouter.post('/banks', adminAuth, async (req, res) => {
  const { bankName, bankCode, country='CM', commissionRate=0.002 } = req.body;
  if (!bankName||!bankCode) return res.status(422).json({ error: 'bankName et bankCode requis' });
  try { const r = await query(`INSERT INTO distribution_banks (bank_name,bank_code,country,commission_rate) VALUES ($1,$2,$3,$4) RETURNING *`,[bankName,bankCode.toUpperCase(),country,commissionRate]); res.status(201).json(r.rows[0]); }
  catch(err){ if(err.code==='23505') return res.status(409).json({error:'Code banque déjà utilisé'}); res.status(500).json({error:err.message}); }
});
adminRouter.post('/banks/:id/users', adminAuth, async (req, res) => {
  const { firstName, lastName, email, phone, password } = req.body;
  if (!firstName||!email||!password) return res.status(422).json({ error: 'Champs requis' });
  try { const hash = await bcrypt.hash(password, 12); const r = await query(`INSERT INTO distribution_users (first_name,last_name,email,phone,password_hash,role,bank_id,created_by_type,created_by_id) VALUES ($1,$2,$3,$4,$5,'bank_admin',$6,'admin',$7) RETURNING user_id,email,role`,[firstName,lastName,email.toLowerCase(),phone||null,hash,req.params.id,req.user.sub]); res.status(201).json(r.rows[0]); }
  catch(err){ if(err.code==='23505') return res.status(409).json({error:'Email déjà utilisé'}); res.status(500).json({error:err.message}); }
});

// Bank
bankRouter.post('/auth/login', async (req,res) => {
  const { email, password } = req.body;
  try {
    const r = await query(`SELECT du.*,b.bank_name,b.bank_code FROM distribution_users du LEFT JOIN distribution_banks b ON b.bank_id=du.bank_id WHERE du.email=$1 AND du.role='bank_admin' AND du.is_active=TRUE LIMIT 1`,[email?.toLowerCase()]);
    if (!r.rows.length) return res.status(401).json({error:'Identifiants incorrects'});
    const u = r.rows[0];
    if (!await bcrypt.compare(password, u.password_hash)) return res.status(401).json({error:'Identifiants incorrects'});
    await query(`UPDATE distribution_users SET last_login_at=NOW() WHERE user_id=$1`,[u.user_id]);
    const token = jwt.sign({sub:u.user_id,role:'bank_admin',bankId:u.bank_id},process.env.JWT_SECRET,{expiresIn:'8h'});
    res.json({access_token:token,user:{userId:u.user_id,firstName:u.first_name,lastName:u.last_name,email:u.email,role:'bank_admin',bank:{bankId:u.bank_id,bankName:u.bank_name}}});
  } catch(err){ res.status(500).json({error:err.message}); }
});
bankRouter.get('/dashboard', bankAuth, async (req,res) => {
  try { const r = await query(`SELECT * FROM bank_dashboard WHERE bank_id=$1`,[req.user.bankId]); res.json(r.rows[0]||{}); }
  catch(err){ res.status(500).json({error:err.message}); }
});
bankRouter.get('/agencies', bankAuth, async (req,res) => {
  try { const r = await query(`SELECT a.*,COUNT(ag.agent_id) as agent_count FROM distribution_agencies a LEFT JOIN distribution_agents ag ON ag.agency_id=a.agency_id WHERE a.bank_id=$1 GROUP BY a.agency_id ORDER BY a.agency_name`,[req.user.bankId]); res.json({data:r.rows}); }
  catch(err){ res.status(500).json({error:err.message}); }
});
bankRouter.post('/agencies', bankAuth, async (req,res) => {
  const {agencyName,agencyCode,city,country='CM',commissionRate=0.0015,maxAgents=50} = req.body;
  if (!agencyName||!agencyCode||!city) return res.status(422).json({error:'Champs requis'});
  try { const r = await query(`INSERT INTO distribution_agencies (bank_id,agency_name,agency_code,city,country,commission_rate,max_agents) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[req.user.bankId,agencyName,agencyCode.toUpperCase(),city,country,commissionRate,maxAgents]); res.status(201).json(r.rows[0]); }
  catch(err){ if(err.code==='23505') return res.status(409).json({error:'Code agence déjà utilisé'}); res.status(500).json({error:err.message}); }
});
bankRouter.post('/agencies/:id/users', bankAuth, async (req,res) => {
  const {firstName,lastName,email,phone,password} = req.body;
  if (!firstName||!email||!password) return res.status(422).json({error:'Champs requis'});
  try { const hash=await bcrypt.hash(password,12); const r=await query(`INSERT INTO distribution_users (first_name,last_name,email,phone,password_hash,role,bank_id,agency_id,created_by_type,created_by_id) VALUES ($1,$2,$3,$4,$5,'agency_admin',$6,$7,'bank_admin',$8) RETURNING user_id,email,role`,[firstName,lastName,email.toLowerCase(),phone||null,hash,req.user.bankId,req.params.id,req.user.sub]); res.status(201).json(r.rows[0]); }
  catch(err){ if(err.code==='23505') return res.status(409).json({error:'Email déjà utilisé'}); res.status(500).json({error:err.message}); }
});
bankRouter.get('/network', bankAuth, async (req,res) => {
  try { const r=await query(`SELECT * FROM distribution_network WHERE bank_id=$1 ORDER BY agency_name,agent_name`,[req.user.bankId]); res.json({data:r.rows}); }
  catch(err){ res.status(500).json({error:err.message}); }
});

// Agency
agencyRouter.post('/auth/login', async (req,res) => {
  const {email,password} = req.body;
  try {
    const r=await query(`SELECT du.*,a.agency_name,b.bank_name FROM distribution_users du LEFT JOIN distribution_agencies a ON a.agency_id=du.agency_id LEFT JOIN distribution_banks b ON b.bank_id=du.bank_id WHERE du.email=$1 AND du.role='agency_admin' AND du.is_active=TRUE LIMIT 1`,[email?.toLowerCase()]);
    if (!r.rows.length) return res.status(401).json({error:'Identifiants incorrects'});
    const u=r.rows[0];
    if (!await bcrypt.compare(password,u.password_hash)) return res.status(401).json({error:'Identifiants incorrects'});
    await query(`UPDATE distribution_users SET last_login_at=NOW() WHERE user_id=$1`,[u.user_id]);
    const token=jwt.sign({sub:u.user_id,role:'agency_admin',bankId:u.bank_id,agencyId:u.agency_id},process.env.JWT_SECRET,{expiresIn:'8h'});
    res.json({access_token:token,user:{userId:u.user_id,firstName:u.first_name,lastName:u.last_name,email:u.email,role:'agency_admin',agency:{agencyId:u.agency_id,agencyName:u.agency_name},bank:{bankId:u.bank_id,bankName:u.bank_name}}});
  } catch(err){ res.status(500).json({error:err.message}); }
});
agencyRouter.get('/dashboard', agencyAuth, async (req,res) => {
  try { const r=await query(`SELECT * FROM agency_dashboard WHERE agency_id=$1`,[req.user.agencyId]); res.json(r.rows[0]||{}); }
  catch(err){ res.status(500).json({error:err.message}); }
});
agencyRouter.get('/agents', agencyAuth, async (req,res) => {
  try { const r=await query(`SELECT ag.*,COUNT(ch.cardholder_id) as cardholder_count FROM distribution_agents ag LEFT JOIN cardholders ch ON ch.agent_id=ag.agent_id WHERE ag.agency_id=$1 GROUP BY ag.agent_id ORDER BY ag.created_at DESC`,[req.user.agencyId]); res.json({data:r.rows}); }
  catch(err){ res.status(500).json({error:err.message}); }
});
agencyRouter.post('/agents', agencyAuth, async (req,res) => {
  const {firstName,lastName,phone,email:agentEmail,password,commissionRate=0.001,cardsLimit=200} = req.body;
  if (!firstName||!lastName||!phone||!password) return res.status(422).json({error:'Champs requis'});
  try {
    // HOTFIX : réponse envoyée après COMMIT
    const created = await withTransaction(async client => {
      const agentCode=`AGT-${Date.now().toString(36).toUpperCase()}`;
      const hash=await bcrypt.hash(password,12);
      const ag=await client.query(`INSERT INTO distribution_agents (agency_id,bank_id,agent_code,first_name,last_name,phone,email,password_hash,commission_rate,cards_limit) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[req.user.agencyId,req.user.bankId,agentCode,firstName,lastName,phone,agentEmail||null,hash,commissionRate,cardsLimit]);
      await client.query(`INSERT INTO distribution_users (first_name,last_name,email,phone,password_hash,role,bank_id,agency_id,agent_id,created_by_type,created_by_id) VALUES ($1,$2,$3,$4,$5,'agent',$6,$7,$8,'agency_admin',$9)`,[firstName,lastName,agentEmail||`${agentCode.toLowerCase()}@cplus.local`,phone,hash,req.user.bankId,req.user.agencyId,ag.rows[0].agent_id,req.user.sub]);
      return { agentId: ag.rows[0].agent_id, agentCode };
    });
    res.status(201).json({success:true, ...created});
  } catch(err){ if(err.code==='23505') return res.status(409).json({error:'Téléphone déjà utilisé'}); res.status(500).json({error:err.message}); }
});

// Agent
agentPortalRouter.post('/auth/login', async (req,res) => {
  const {email,password} = req.body;
  try {
    const r=await query(`SELECT du.*,ag.agent_code,ag.cards_issued,ag.cards_limit,a.agency_name,b.bank_name FROM distribution_users du LEFT JOIN distribution_agents ag ON ag.agent_id=du.agent_id LEFT JOIN distribution_agencies a ON a.agency_id=du.agency_id LEFT JOIN distribution_banks b ON b.bank_id=du.bank_id WHERE du.email=$1 AND du.role='agent' AND du.is_active=TRUE LIMIT 1`,[email?.toLowerCase()]);
    if (!r.rows.length) return res.status(401).json({error:'Identifiants incorrects'});
    const u=r.rows[0];
    if (!await bcrypt.compare(password,u.password_hash)) return res.status(401).json({error:'Identifiants incorrects'});
    await query(`UPDATE distribution_users SET last_login_at=NOW() WHERE user_id=$1`,[u.user_id]);
    const token=jwt.sign({sub:u.user_id,role:'agent',bankId:u.bank_id,agencyId:u.agency_id,agentId:u.agent_id},process.env.JWT_SECRET,{expiresIn:'8h'});
    res.json({access_token:token,user:{userId:u.user_id,firstName:u.first_name,lastName:u.last_name,email:u.email,role:'agent',agent:{agentId:u.agent_id,agentCode:u.agent_code,cardsIssued:u.cards_issued,cardsLimit:u.cards_limit},agency:{agencyId:u.agency_id,agencyName:u.agency_name},bank:{bankId:u.bank_id,bankName:u.bank_name}}});
  } catch(err){ res.status(500).json({error:err.message}); }
});
agentPortalRouter.get('/dashboard', agentAuth, async (req,res) => {
  try { const r=await query(`SELECT * FROM agent_performance WHERE agent_id=$1`,[req.user.agentId]); res.json(r.rows[0]||{}); }
  catch(err){ res.status(500).json({error:err.message}); }
});
agentPortalRouter.get('/cardholders', agentAuth, async (req,res) => {
  try { const r=await query(`SELECT ch.*,vc.card_masked,vc.balance,vc.status as card_status FROM cardholders ch LEFT JOIN virtual_cards vc ON vc.card_id=ch.card_id WHERE ch.agent_id=$1 ORDER BY ch.created_at DESC LIMIT 50`,[req.user.agentId]); res.json({data:r.rows}); }
  catch(err){ res.status(500).json({error:err.message}); }
});
agentPortalRouter.post('/cardholders', agentAuth, async (req,res) => {
  const {firstName,lastName,phone,email:chEmail,dateOfBirth,idType,idNumber,country='CM',password} = req.body;
  if (!firstName||!lastName||!phone||!password) return res.status(422).json({error:'Champs requis'});
  try {
    const agRes=await query(`SELECT cards_issued,cards_limit FROM distribution_agents WHERE agent_id=$1`,[req.user.agentId]);
    const ag=agRes.rows[0];
    if (ag.cards_issued>=ag.cards_limit) return res.status(429).json({error:`Quota atteint (${ag.cards_limit})`});
    const hash=await bcrypt.hash(password,12);
    // HOTFIX : réponse envoyée après COMMIT ; la carte est rattachée à son porteur (IDOR)
    const created = await withTransaction(async client => {
      const cardId=uuidv4(),chId=uuidv4(),last4=Math.floor(1000+Math.random()*9000).toString(),cardNum=('4000000000000000'+last4).slice(-16),masked=`${cardNum.slice(0,4)} **** **** ${last4}`,expYear=new Date().getFullYear()+3,emboss=`${firstName.slice(0,13).toUpperCase()} ${lastName.slice(0,13).toUpperCase()}`;
      await client.query(`INSERT INTO virtual_cards (card_id,cardholder_id,card_number,card_masked,cardholder_name,expiry_month,expiry_year,balance,currency,network,country) VALUES ($1,$2,$3,$4,$5,12,$6,0,'XAF','visa',$7)`,[cardId,chId,cardNum,masked,emboss,expYear,country]);
      await client.query(`INSERT INTO cardholders (cardholder_id,card_id,first_name,last_name,phone,email,date_of_birth,id_type,id_number,country,password_hash,kyc_level,agent_id,agency_id,bank_id,onboarded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,$12,$13,$14,'agent')`,[chId,cardId,firstName,lastName,phone,chEmail||null,dateOfBirth||null,idType||null,idNumber||null,country,hash,req.user.agentId,req.user.agencyId,req.user.bankId]);
      await client.query(`UPDATE distribution_agents SET cards_issued=cards_issued+1 WHERE agent_id=$1`,[req.user.agentId]);
      return { chId, cardId, masked, emboss, expYear };
    });
    const { chId, cardId, masked, emboss, expYear } = created;
    res.status(201).json({success:true,cardholderId:chId,card:{cardId,cardMasked:masked,cardholderName:emboss,expiryMonth:12,expiryYear:expYear}});
  } catch(err){ if(err.code==='23505') return res.status(409).json({error:'Téléphone déjà utilisé'}); res.status(500).json({error:err.message}); }
});

module.exports = { adminRouter, bankRouter, agencyRouter, agentPortalRouter };
