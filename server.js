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
let menuData = {"restaurante":{"nombre":"El Melao de Inés","subtitulo":"restobar"},"categorias":[{"id":"bebidas","label":"Bebidas","dest":"barra1","items":[{"id":"bv1","n":"Copas de vino","p":3.50},{"id":"bv2","n":"Tinto de verano (copa)","p":4.00},{"id":"bv3","n":"Caña","p":2.20},{"id":"bv4","n":"Doble","p":3.20},{"id":"bv5","n":"Cerveza Tercio","p":3.20},{"id":"bv6","n":"Cerveza Corona","p":4.00},{"id":"bv7","n":"Cerveza Sin Gluten","p":3.50},{"id":"bv8","n":"Cerveza 0.0","p":3.20},{"id":"bv9","n":"Cerveza 0.0 Tostada","p":3.20},{"id":"bv10","n":"Coca-Cola Original","p":2.50},{"id":"bv11","n":"Coca-Cola Zero","p":2.50},{"id":"bv12","n":"Coca-Cola Zero Zero","p":2.50},{"id":"bv13","n":"Fanta","p":2.50},{"id":"bv14","n":"Sprite","p":2.50},{"id":"bv15","n":"Nestea","p":2.50},{"id":"bv16","n":"Aquarius Limón","p":2.50},{"id":"bv17","n":"Aquarius Naranja","p":2.50},{"id":"bv18","n":"Tónica","p":2.50},{"id":"bv19","n":"Red Bull","p":3.00},{"id":"bv20","n":"Agua pequeña","p":2.00},{"id":"bv21","n":"Agua grande","p":3.50},{"id":"bv22","n":"Café / Infusión","p":2.00},{"id":"bv23","n":"Papelón con limón (vaso)","p":3.50},{"id":"bv24","n":"Papelón con limón (jarra)","p":15.00}]},{"id":"entrantes","label":"Entrantes","dest":"cocina","items":[{"id":"en0","n":"Tequeños (6 uds)","p":8.00},{"id":"en1","n":"Ensalada Mixta","p":12.00},{"id":"en2","n":"Ensalada César con pollo","p":12.50},{"id":"en3","n":"Vegetales a la Brasa","p":13.00},{"id":"en4","n":"Ensalada Rusa","p":11.00},{"id":"en5","n":"Ensalada Melao","p":12.00},{"id":"en6","n":"Alitas de Pollo (8 uds)","p":9.00},{"id":"en7","n":"Croquetas de jamón (8 uds)","p":10.00},{"id":"en8","n":"Calamares","p":12.00},{"id":"en9","n":"Samburiño","p":15.00},{"id":"en10","n":"Gambas al ajillo","p":12.00},{"id":"en11","n":"Gambas a la gabardina","p":10.00},{"id":"en12","n":"Patatas fritas","p":7.00},{"id":"en13","n":"Patatas bravas","p":8.00}]},{"id":"barbacoa","label":"Barbacoa y Brasa","dest":"barbacoa","items":[{"id":"bb1","n":"Carne en Vara (1 Kg)","p":65.00},{"id":"bb2","n":"Carne en Vara (½ Kg)","p":32.50},{"id":"bb3","n":"Carne en Vara (¼ Kg)","p":16.00},{"id":"bb4","n":"Salmón","p":19.00},{"id":"bb5","n":"Dorado","p":14.00},{"id":"bb6","n":"Lubina","p":14.00},{"id":"bb7","n":"Parrilla Mixta 4 pers.","p":80.00},{"id":"bb8","n":"Parrilla Mixta 2 pers.","p":40.00},{"id":"bb9","n":"Cachopo de ternera","p":22.00},{"id":"bb10","n":"Cachopo de pollo","p":18.00},{"id":"bb11","n":"Cachopo de cerdo","p":18.00},{"id":"bb12","n":"Chorizo","p":6.50},{"id":"bb13","n":"Morcilla","p":6.00},{"id":"bb14","n":"Yuca sancochada (ración)","p":5.00}]},{"id":"fastfood","label":"Fast Food","dest":"cocina","items":[{"id":"ff1","n":"Mi Burger Clásica","p":10.00},{"id":"ff2","n":"Mi Burger BBQ","p":12.00},{"id":"ff3","n":"Mi Burger Doble Carne","p":14.00},{"id":"ff4","n":"Mi Burger El Melao","p":16.00},{"id":"ff5","n":"Pizza Margarita","p":11.00},{"id":"ff6","n":"Pizza Prosciutto","p":12.00},{"id":"ff7","n":"Pizza Diavola Dolce","p":13.00}]},{"id":"kids","label":"Kids","dest":"cocina","items":[{"id":"ki1","n":"Hamburguesa con queso y bacon","p":9.00},{"id":"ki2","n":"Fingers de pollo (6 uds)","p":8.00}]},{"id":"postres","label":"Postres","dest":"cocina","items":[{"id":"po1","n":"Helado de cono Deresa","p":3.00},{"id":"po2","n":"Torta Red Velvet","p":5.00},{"id":"po3","n":"Arroz con leche","p":3.00},{"id":"po4","n":"Flan de café","p":3.00},{"id":"po5","n":"Flan de queso","p":3.00}]}]};

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
  const html=`<!DOCTYPE html><html><body style="font-family:system-ui;background:#f5f5f5;margin:0;padding:20px"><div style="max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)"><div style="background:#c2185b;padding:28px 32px"><div style="font-size:22px;font-weight:800;color:#fff">El Melao de Inés · Reporte</div><div style="font-size:14px;color:rgba(255,255,255,.8);margin-top:4px;text-transform:capitalize">${fecha}</div></div><div style="padding:28px 32px"><div style="display:flex;gap:16px;margin-bottom:16px"><div style="flex:1;background:#fce4ec;border:1.5px solid #c2185b;border-radius:12px;padding:16px;text-align:center"><div style="font-size:32px;font-weight:800;color:#c2185b">${totalVentas.toFixed(2)} €</div><div style="font-size:13px;color:#888;margin-top:4px">Facturación (IVA incl.)</div></div><div style="flex:1;background:#e8f5e9;border:1.5px solid #41d36f;border-radius:12px;padding:16px;text-align:center"><div style="font-size:32px;font-weight:800;color:#41d36f">${totalComandas}</div><div style="font-size:13px;color:#888;margin-top:4px">Comandas</div></div></div><div style="margin-bottom:24px"><div style="font-size:13px;font-weight:800;color:#888;text-transform:uppercase;margin-bottom:10px">Por categoría</div><table style="width:100%;border-collapse:collapse;font-size:14px"><thead><tr style="background:#f5f5f5"><th style="padding:8px 12px;text-align:left">Cat.</th><th style="padding:8px 12px;text-align:center">Uds.</th><th style="padding:8px 12px;text-align:right">Total</th></tr></thead><tbody>${catRows}</tbody></table></div><div><div style="font-size:13px;font-weight:800;color:#888;text-transform:uppercase;margin-bottom:10px">Top 5</div><table style="width:100%;border-collapse:collapse;font-size:14px"><thead><tr style="background:#f5f5f5"><th style="padding:8px 12px;text-align:left">Plato</th><th style="padding:8px 12px;text-align:center">Uds.</th><th style="padding:8px 12px;text-align:right">Total</th></tr></thead><tbody>${top5Rows}</tbody></table></div></div><div style="background:#f5f5f5;padding:16px 32px;font-size:12px;color:#aaa;text-align:center">QuickOrder</div></div></body></html>`;
  try{
    const res=await fetch('https://api.resend.com/emails',{method:'POST',headers:{'Authorization':'Bearer '+RESEND_KEY,'Content-Type':'application/json'},body:JSON.stringify({from:FROM_EMAIL,to:[REPORT_EMAIL],subject:`El Melao · ${fecha} · ${totalVentas.toFixed(2)} €`,html})});
    const data=await res.json();
    if(res.ok) log(`Reporte enviado | ${totalVentas.toFixed(2)} €`);
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
