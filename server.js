const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ─── Config reporte ───────────────────────────────────────────────────────────
const RESEND_KEY   = process.env.RESEND_KEY   || '';
const REPORT_EMAIL = process.env.REPORT_EMAIL || '';
const FROM_EMAIL   = process.env.FROM_EMAIL   || 'onboarding@resend.dev';

// ─── Estado en memoria ───────────────────────────────────────────────────────
let mesas = Array.from({ length: 10 }, (_, i) => ({
  id: i + 1, tipo: 'mesa', estado: 'libre', items: [], total: 0
}));
let clientes = [];
let orders = [];
let bills  = [];

// ─── Helpers ─────────────────────────────────────────────────────────────────
function broadcast(data, skip) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === 1 && c !== skip) c.send(msg); });
}
function broadcastToRole(role, data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === 1 && c._role === role) c.send(msg); });
}
function sendTo(s, d) { if (s.readyState === 1) s.send(JSON.stringify(d)); }
function log(m) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`); }

// ─── WebSocket ────────────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const p = new URL(req.url, 'http://x').searchParams;
  ws._role = p.get('role') || 'waiter';
  log(`Conectado: ${ws._role} (total: ${wss.clients.size})`);

  sendTo(ws, { type: 'sync', mesas, clientes });

  // Enviar pendientes según rol
  const roleDestMap = { kitchen: 'cocina', barbacoa: 'barbacoa', bar1: 'barra1', bar2: 'barra2', cash: 'caja' };
  const dest = roleDestMap[ws._role];
  if (dest) {
    const pend = orders.filter(o => o.status === 'pending' && o.dest === dest);
    pend.forEach(o => sendTo(ws, o));
    if (pend.length) log(`Enviadas ${pend.length} pendientes a ${ws._role}`);
  }
  if (ws._role === 'cash') {
    const bp = bills.filter(b => b.status === 'pending');
    bp.forEach(b => sendTo(ws, b));
    if (bp.length) log(`Enviadas ${bp.length} cuentas a caja`);
    // Enviar copias de TODOS los pedidos del día para control
    orders.forEach(o => sendTo(ws, { ...o, type: 'order-copy' }));
    if (orders.length) log(`Enviadas ${orders.length} copias de pedidos a caja`);
  }

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'sync': {
        if (Array.isArray(msg.mesas))    mesas    = msg.mesas;
        if (Array.isArray(msg.clientes)) clientes = msg.clientes;
        broadcast({ type: 'sync', mesas, clientes }, ws);
        break;
      }
      case 'order': {
        const order = {
          id: Date.now(), type: 'order',
          mesa: msg.mesa, label: msg.label || `Mesa ${msg.mesa}`,
          camarero: msg.camarero || '',
          orderNum: msg.orderNum || '',
          dest: msg.dest, items: msg.items || [],
          nota: msg.nota || '', total: msg.total || 0,
          time: msg.time || new Date().toISOString(), status: 'pending'
        };
        orders.push(order);
        const destRole = { barra1:'bar1', barra2:'bar2', cocina:'kitchen', barbacoa:'barbacoa', caja:'cash' }[msg.dest] || msg.dest;
        const roles = Array.from(wss.clients).map(c=>c._role).join(', ');
        log(`Roles conectados: [${roles}] | buscando: ${destRole}`);
        broadcastToRole(destRole, order);
        // Enviar copia a caja siempre (para control de cuenta)
        if (destRole !== 'cash') {
          broadcastToRole('cash', { ...order, type: 'order-copy' });
        }
        // Enviar todos los pedidos a la impresora (auto-print comanda)
        broadcastToRole('printer', order);
        sendTo(ws, { type: 'ack', orderId: order.id, dest: msg.dest });
        log(`Pedido #${order.id} | ${order.label} → ${msg.dest} (${order.items.length} ítems) [${order.camarero}]`);
        break;
      }
      case 'ready': {
        const o = orders.find(x => x.id === msg.orderId || (x.mesa === msg.mesa && x.status === 'pending'));
        if (o) o.status = 'ready';
        broadcastToRole('waiter', {
          type: 'notify', action: 'ready',
          mesa: msg.mesa, label: msg.label, item: msg.item, orderId: msg.orderId
        });
        log(`Listo: ${msg.label} → "${msg.item}"`);
        break;
      }
      case 'bill': {
        const bill = {
          id: Date.now(), type: 'bill',
          mesa: msg.mesa, label: msg.label || `Mesa ${msg.mesa}`,
          camarero: msg.camarero || '',
          items: msg.items || [], total: msg.total || 0,
          nota: msg.nota || '', time: new Date().toISOString(), status: 'pending'
        };
        bills.push(bill);
        broadcastToRole('cash', bill);
        log(`Cuenta: ${bill.label} → caja`);
        break;
      }
      case 'close': {
        const m = mesas.find(x => x.id === msg.mesa);
        if (m) { m.items = []; m.total = 0; m.estado = 'libre'; }
        if (Array.isArray(msg.clientes)) clientes = msg.clientes;
        const b = bills.find(x => x.mesa === msg.mesa && x.status === 'pending');
        if (b) b.status = 'paid';
        broadcast({ type: 'sync', mesas, clientes }, ws);
        log(`Cerrado: ${msg.mesa}`);
        break;
      }
      default: log(`Tipo desconocido: ${msg.type}`);
    }
  });
  ws.on('close', () => log(`Desconectado: ${ws._role} (total: ${wss.clients.size})`));
});

// ─── REST ─────────────────────────────────────────────────────────────────────
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/', (_, res) => res.json({ ok: true, app: 'QuickOrder · El Melao de Inés' }));

// ─── MENÚ ─────────────────────────────────────────────────────────────────────
let menuData = {"restaurante":{"nombre":"El Melao de Inés","subtitulo":"restobar"},"categorias":[{"id":"bebidas","label":"Bebidas","dest":"barra1","items":[{"id":"bv1","n":"Copas de vino","p":3.5},{"id":"bv2","n":"Tinto de verano (copa)","p":4.5},{"id":"bv3","n":"Cerveza","p":3.5},{"id":"bv4","n":"Refrescos (lata)","p":2.5},{"id":"bv5","n":"Agua pequeña","p":2.0},{"id":"bv6","n":"Café / Infusión","p":2.0},{"id":"bv7","n":"Papelón con limón (vaso)","p":3.5},{"id":"bv8","n":"Papelón con limón (jarra)","p":15.0}]},{"id":"comenzar","label":"Para comenzar","dest":"cocina","items":[{"id":"cm1","n":"Salmorejo cordobés","p":8},{"id":"cm2","n":"Consomé","p":6},{"id":"cm3","n":"Espárragos con dos salsas","p":10},{"id":"cm4","n":"Sopa castellana","p":8}]},{"id":"entrantes","label":"Entrantes","dest":"cocina","items":[{"id":"en1","n":"Tequeños (6 uds)","p":8},{"id":"en2","n":"Empanadas (4 uds)","p":8},{"id":"en3","n":"Ensalada mixta","p":8},{"id":"en4","n":"Ensalada de ventresca","p":14},{"id":"en5","n":"Ensalada rusa","p":9},{"id":"en6","n":"Queso curado","p":10},{"id":"en7","n":"Croquetas de jamón (8 uds)","p":10},{"id":"en8","n":"Jamón ibérico","p":16},{"id":"en9","n":"Tortilla de patatas (ración)","p":2.5},{"id":"en10","n":"Tortilla entera","p":14},{"id":"en11","n":"Patatas bravas","p":8},{"id":"en12","n":"Gambas al ajillo","p":12},{"id":"en13","n":"Pulpo a la gallega","p":18}]},{"id":"parrilla","label":"Parrilla","dest":"barbacoa","items":[{"id":"pa1","n":"Carne en Vara (1 Kg)","p":60},{"id":"pa2","n":"Carne en Vara (½ Kg)","p":30},{"id":"pa3","n":"Carne en Vara (¼ Kg)","p":15},{"id":"pa4","n":"Pollo en Vara (1 Kg)","p":18},{"id":"pa5","n":"Pollo en Vara (½ Kg)","p":9},{"id":"pa6","n":"Pollo en Vara (¼ Kg)","p":4.5}]},{"id":"principales","label":"Principales","dest":"cocina","items":[{"id":"pr1","n":"Merluza a la romana","p":16},{"id":"pr2","n":"Entrecot a la parrilla (300 gr)","p":22},{"id":"pr3","n":"Cachopo de ternera","p":22},{"id":"pr4","n":"Cachopo de pollo","p":18},{"id":"pr5","n":"Cachopo de cerdo","p":18},{"id":"pr6","n":"Pollo al ajillo","p":14},{"id":"pr7","n":"Pechuga de pollo a la plancha","p":11}]},{"id":"criollas","label":"Criollas","dest":"cocina","items":[{"id":"ar1","n":"Arepa de ternera mechada","p":9},{"id":"ar2","n":"Arepa reina pepiada","p":10},{"id":"ar3","n":"Arepa pollo desmechado","p":9},{"id":"ar4","n":"Arepa pabellón","p":10},{"id":"ca1","n":"Cachapa con queso","p":12},{"id":"ca2","n":"Cachapa con queso y cochino frito","p":15},{"id":"cr1","n":"Patacones","p":15}]},{"id":"fastfood","label":"Fast Food","dest":"cocina","items":[{"id":"hb1","n":"Mi Burger Clásica","p":10},{"id":"hb2","n":"Mi Burger BBQ","p":12},{"id":"hb3","n":"Mi Burger Doble Carne","p":14},{"id":"hb4","n":"Mi Burger El Melao","p":16},{"id":"fp1","n":"Pizza Margarita","p":10},{"id":"fp2","n":"Pizza Jamón y queso","p":12},{"id":"fp3","n":"Pizza Diavola","p":12},{"id":"fp4","n":"Pizza Barbacoa","p":14},{"id":"bo1","n":"Bocadillo Calamares","p":8},{"id":"bo2","n":"Bocadillo Lomo","p":8},{"id":"bo3","n":"Bocadillo Jamón y queso","p":7},{"id":"bo4","n":"Bocadillo Bacon y queso","p":8}]},{"id":"kids","label":"Kids","dest":"cocina","items":[{"id":"ki1","n":"Hamburguesa con queso y bacon","p":9},{"id":"ki2","n":"Fingers de pollo (6 uds)","p":8},{"id":"ki3","n":"Tortilla de jamón y queso (rac.)","p":3},{"id":"ki4","n":"Lomo de cerdo a la plancha","p":7},{"id":"ki5","n":"Pasta bolognesa","p":7},{"id":"ki6","n":"Pechuga de pollo a la plancha","p":8}]},{"id":"postres","label":"Postres","dest":"cocina","items":[{"id":"po1","n":"Tres leches","p":6},{"id":"po2","n":"Red Velvet","p":5},{"id":"po3","n":"De frutas","p":5},{"id":"po4","n":"Helado","p":4},{"id":"po5","n":"Tarta de chocolate","p":5},{"id":"po6","n":"Mousse de limón","p":5}]},{"id":"guarniciones","label":"Guarniciones","dest":"barbacoa","items":[{"id":"gu1","n":"Arroz blanco","p":3},{"id":"gu2","n":"Patatas fritas","p":3},{"id":"gu3","n":"Papas al vapor","p":3},{"id":"gu4","n":"Chorizo (1 ud)","p":9.5},{"id":"gu5","n":"Morcilla (1 ud)","p":8.5},{"id":"gu6","n":"Yuca sancochada (ración)","p":5}]}]};

app.get('/menu', (_, res) => res.json(menuData));

app.post('/menu/:catId/items', (req, res) => {
  const cat = menuData.categorias.find(c => c.id === req.params.catId);
  if (!cat) return res.status(404).json({ error: 'Categoría no encontrada' });
  const { n, p } = req.body;
  if (!n || p === undefined) return res.status(400).json({ error: 'Nombre y precio requeridos' });
  const id = req.params.catId.slice(0, 2) + '_' + Date.now();
  const item = { id, n, p: Number(p) };
  cat.items.push(item);
  broadcast({ type: 'menu-update', menu: menuData });
  log(`Menú: añadido "${n}" a ${cat.label}`);
  res.json(item);
});

app.put('/menu/items/:itemId', (req, res) => {
  for (const cat of menuData.categorias) {
    const item = cat.items.find(x => x.id === req.params.itemId);
    if (item) {
      if (req.body.n !== undefined) item.n = req.body.n;
      if (req.body.p !== undefined) item.p = Number(req.body.p);
      broadcast({ type: 'menu-update', menu: menuData });
      log(`Menú: editado "${item.n}" → ${item.p}€`);
      return res.json(item);
    }
  }
  res.status(404).json({ error: 'Plato no encontrado' });
});

app.delete('/menu/items/:itemId', (req, res) => {
  for (const cat of menuData.categorias) {
    const idx = cat.items.findIndex(x => x.id === req.params.itemId);
    if (idx !== -1) {
      const removed = cat.items.splice(idx, 1)[0];
      broadcast({ type: 'menu-update', menu: menuData });
      log(`Menú: eliminado "${removed.n}"`);
      return res.json({ ok: true });
    }
  }
  res.status(404).json({ error: 'Plato no encontrado' });
});

app.post('/menu/categorias', (req, res) => {
  const { id, label, dest } = req.body;
  if (!id || !label) return res.status(400).json({ error: 'id y label requeridos' });
  menuData.categorias.push({ id, label, dest: dest || 'cocina', items: [] });
  broadcast({ type: 'menu-update', menu: menuData });
  log(`Menú: nueva categoría "${label}"`);
  res.json({ ok: true });
});

app.delete('/menu/categorias/:catId', (req, res) => {
  const idx = menuData.categorias.findIndex(c => c.id === req.params.catId);
  if (idx === -1) return res.status(404).json({ error: 'Categoría no encontrada' });
  if (menuData.categorias[idx].items.length > 0) return res.status(400).json({ error: 'La categoría tiene platos' });
  const removed = menuData.categorias.splice(idx, 1)[0];
  broadcast({ type: 'menu-update', menu: menuData });
  log(`Menú: eliminada "${removed.label}"`);
  res.json({ ok: true });
});

app.put('/menu/restaurante', (req, res) => {
  if (req.body.nombre) menuData.restaurante.nombre = req.body.nombre;
  if (req.body.subtitulo) menuData.restaurante.subtitulo = req.body.subtitulo;
  broadcast({ type: 'menu-update', menu: menuData });
  res.json(menuData.restaurante);
});

app.get('/status', (_, res) => res.json({
  mesas: mesas.length, ocupadas: mesas.filter(m => m.estado === 'ocupada').length,
  clientes: clientes.length, ordersToday: orders.length, connected: wss.clients.size
}));

// ─── Numeración de tickets ────────────────────────────────────────────────────
let ticketSeq = 1;
app.post('/ticket-number', (_, res) => {
  const year = new Date().getFullYear();
  const num = ticketSeq++;
  const id = `${year}-${String(num).padStart(4,'0')}`;
  log(`Ticket generado: ${id}`);
  res.json({ id, num, year });
});

// ─── Enviar ticket por email ──────────────────────────────────────────────────
app.post('/ticket-email', async (req, res) => {
  if (!RESEND_KEY) return res.status(500).json({ error: 'Resend no configurado' });
  const { to, ticketHtml, subject } = req.body;
  if (!to || !ticketHtml) return res.status(400).json({ error: 'email y ticketHtml requeridos' });
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [to],
        subject: subject || 'Factura simplificada · El Melao de Inés',
        html: ticketHtml
      })
    });
    const data = await r.json();
    if (r.ok) { log(`Ticket enviado a ${to}`); res.json({ ok: true }); }
    else { log(`Error email: ${JSON.stringify(data)}`); res.status(500).json(data); }
  } catch (e) { log(`Error email: ${e.message}`); res.status(500).json({ error: e.message }); }
});

app.get('/orders', (_, res) => res.json(orders));

app.post('/reset', (_, res) => {
  mesas = mesas.map(m => ({ ...m, items: [], total: 0, estado: 'libre' }));
  clientes = []; orders = []; bills = []; ticketSeq = 1;
  broadcast({ type: 'sync', mesas, clientes });
  log('Reset del día');
  res.json({ ok: true });
});

// ─── Reporte diario ───────────────────────────────────────────────────────────
async function enviarReporte() {
  if (!orders.length || !RESEND_KEY || !REPORT_EMAIL) { log('Reporte: sin datos o sin config'); return; }
  const fecha = new Date().toLocaleDateString('es-ES', {weekday:'long',year:'numeric',month:'long',day:'numeric',timeZone:'Europe/Madrid'});
  const totalVentas = orders.reduce((s,o)=>s+(o.total||0),0);
  const totalIva = totalVentas*0.10;
  const totalConIva = totalVentas*1.10;
  const totalComandas = orders.length;
  const porCat = {};
  orders.forEach(o=>(o.items||[]).forEach(it=>{
    const cat=it.cat||'otros';
    if(!porCat[cat])porCat[cat]={qty:0,total:0};
    porCat[cat].qty+=(it.q||1);porCat[cat].total+=(it.p||0)*(it.q||1);
  }));
  const porPlato = {};
  orders.forEach(o=>(o.items||[]).forEach(it=>{
    if(!porPlato[it.n])porPlato[it.n]={qty:0,total:0};
    porPlato[it.n].qty+=(it.q||1);porPlato[it.n].total+=(it.p||0)*(it.q||1);
  }));
  const top5=Object.entries(porPlato).sort((a,b)=>b[1].qty-a[1].qty).slice(0,5);
  const catRows=Object.entries(porCat).map(([c,d])=>`<tr><td style="padding:8px 12px;text-transform:capitalize">${c}</td><td style="padding:8px 12px;text-align:center">${d.qty}</td><td style="padding:8px 12px;text-align:right;font-weight:700">${d.total.toFixed(2)} €</td></tr>`).join('');
  const top5Rows=top5.map(([n,d])=>`<tr><td style="padding:8px 12px">${n}</td><td style="padding:8px 12px;text-align:center">${d.qty}</td><td style="padding:8px 12px;text-align:right">${d.total.toFixed(2)} €</td></tr>`).join('');
  const html=`<!DOCTYPE html><html><body style="font-family:system-ui;background:#f5f5f5;margin:0;padding:20px"><div style="max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)"><div style="background:#c2185b;padding:28px 32px"><div style="font-size:22px;font-weight:800;color:#fff">El Melao de Inés · Reporte</div><div style="font-size:14px;color:rgba(255,255,255,.8);margin-top:4px;text-transform:capitalize">${fecha}</div></div><div style="padding:28px 32px"><div style="display:flex;gap:16px;margin-bottom:16px"><div style="flex:1;background:#fce4ec;border:1.5px solid #c2185b;border-radius:12px;padding:16px;text-align:center"><div style="font-size:32px;font-weight:800;color:#c2185b">${totalConIva.toFixed(2)} €</div><div style="font-size:13px;color:#888;margin-top:4px">Facturación (con IVA)</div></div><div style="flex:1;background:#e8f5e9;border:1.5px solid #41d36f;border-radius:12px;padding:16px;text-align:center"><div style="font-size:32px;font-weight:800;color:#41d36f">${totalComandas}</div><div style="font-size:13px;color:#888;margin-top:4px">Comandas</div></div></div><div style="background:#f9f9f9;border-radius:10px;padding:12px 16px;margin-bottom:24px;font-size:13px"><div style="display:flex;justify-content:space-between;padding:3px 0;color:#666"><span>Subtotal (sin IVA)</span><span>${totalVentas.toFixed(2)} €</span></div><div style="display:flex;justify-content:space-between;padding:3px 0;color:#666"><span>IVA 10%</span><span>${totalIva.toFixed(2)} €</span></div><div style="display:flex;justify-content:space-between;padding:5px 0 0;font-weight:800;color:#c2185b"><span>TOTAL</span><span>${totalConIva.toFixed(2)} €</span></div></div><div style="margin-bottom:24px"><div style="font-size:13px;font-weight:800;color:#888;text-transform:uppercase;margin-bottom:10px">Por categoría</div><table style="width:100%;border-collapse:collapse;font-size:14px"><thead><tr style="background:#f5f5f5"><th style="padding:8px 12px;text-align:left">Cat.</th><th style="padding:8px 12px;text-align:center">Uds.</th><th style="padding:8px 12px;text-align:right">Sin IVA</th></tr></thead><tbody>${catRows}</tbody></table></div><div><div style="font-size:13px;font-weight:800;color:#888;text-transform:uppercase;margin-bottom:10px">Top 5</div><table style="width:100%;border-collapse:collapse;font-size:14px"><thead><tr style="background:#f5f5f5"><th style="padding:8px 12px;text-align:left">Plato</th><th style="padding:8px 12px;text-align:center">Uds.</th><th style="padding:8px 12px;text-align:right">Sin IVA</th></tr></thead><tbody>${top5Rows}</tbody></table></div></div><div style="background:#f5f5f5;padding:16px 32px;font-size:12px;color:#aaa;text-align:center">QuickOrder</div></div></body></html>`;
  try{
    const res=await fetch('https://api.resend.com/emails',{method:'POST',headers:{'Authorization':'Bearer '+RESEND_KEY,'Content-Type':'application/json'},body:JSON.stringify({from:FROM_EMAIL,to:[REPORT_EMAIL],subject:`El Melao · ${fecha} · ${totalConIva.toFixed(2)} €`,html})});
    const data=await res.json();
    if(res.ok) log(`Reporte enviado | ${totalConIva.toFixed(2)} € (sin IVA: ${totalVentas.toFixed(2)} €)`);
    else log(`Error Resend: ${JSON.stringify(data)}`);
  }catch(e){log(`Error reporte: ${e.message}`);}
  orders=[];bills=[];ticketSeq=1;
  mesas=mesas.map(m=>({...m,items:[],total:0,estado:'libre'}));clientes=[];
  broadcast({type:'sync',mesas,clientes});log('Reset automático');
}

function scheduleReport(){
  const now=new Date(),target=new Date();
  target.setHours(1,0,0,0);
  if(now>=target)target.setDate(target.getDate()+1);
  const ms=target-now;
  log(`Próximo reporte en ${Math.round(ms/1000/60)} min`);
  setTimeout(()=>{enviarReporte();setInterval(enviarReporte,86400000);},ms);
}
scheduleReport();

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => log(`El Melao backend en :${PORT}`));
