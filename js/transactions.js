      /* Activity, transaction history, and calendar */
      function evs(k) {
        const d = +k.slice(8),
          a = [];
        S.tx
          .filter((t) => t.d == k)
          .forEach((t) =>
            a.push({
              c: t.amt > 0 ? "i" : "o",
              t: (t.note || t.cat) + " (" + php(Math.abs(t.amt)) + ")",
              kind: "tx",
              id: t.id,
            }),
          );
        S.accts
          .filter((c) => c.type == "credit")
          .forEach((c) => {
            if (
              c.stmt &&
              d == Math.min(c.stmt, new Date(+k.slice(0, 4), +k.slice(5, 7), 0).getDate())
            )
              a.push({ c: "s", t: c.bank + " Statement Closes", kind: "stmt", id: c.id });
            if (dueOn(c, k)) a.push({ c: "u", t: c.bank + " Due Date", kind: "due", id: c.id });
          });
        S.bills.forEach((b) => {
          if (bOn(b, k))
            a.push({ c: "u", t: b.name + " Due (" + php(b.amt) + ")", kind: "bill", id: b.id });
        });
        return a;
      }
      function rowH(k, e, j) {
        let o,
          ic,
          sub,
          am = "",
          actions = "";
        if (e.kind == "tx") {
          o = S.tx.find((x) => x.id == e.id);
          ic = ti(o);
          sub = o.cat + " · " + acct(o.acct).name + (k > today ? " · Planned" : "");
          am = `<b class="${o.amt > 0 ? "g" : "r"}">${o.amt > 0 ? "+" : ""}${php(o.amt)}</b>`;
          actions = `<button class="pill dots" aria-label="Edit transaction" onclick="event.stopPropagation();editTx(${o.id})">${DOTS}</button>`;
        } else if (e.kind == "bill") {
          o = S.bills.find((x) => x.id == e.id);
          ic = bIc(o);
          sub =
            "Bill · " + (bPaid(o, k) ? "Paid" : k >= today ? "Planned" : "Scheduled");
          am = `<b class="r">−${php(o.amt)}</b>`;
        } else {
          o = acct(e.id);
          ic = cardLogo(o) || "💳";
          sub = e.kind == "due" ? "Card payment due" : "Statement closes";
          am = e.kind == "due" ? `<b class="r">${php(dueAmt(o))}</b>` : "";
        }
        return `<div class="row" ${e.kind == "tx" ? `data-tx="${e.id}"` : ""} style="cursor:pointer" onclick="evDetail('${k}',${j})"><div class="ico">${ic}</div><div class="f">${esc(tt(e.t))}<small>${sub}</small></div>${am}${actions}</div>`;
      }
      function dayItems(k) {
        const l = evs(k),
          dt = new Date(k + "T00:00:00");
        return (
          `<div class="eyebrow" style="margin-bottom:6px">${dt.toLocaleDateString("en-PH", { weekday: "long", month: "long", day: "numeric" })} · ${l.length} ${l.length == 1 ? "entry" : "entries"}</div>` +
          (l.map((e, j) => rowH(k, e, j)).join("") || '<p class="m">Nothing on this day.</p>')
        );
      }
      function upItems() {
        let h = "";
        const p = (x) => String(x).padStart(2, "0");
        for (let i = 0; i < 45; i++) {
          const dt = new Date(T.getFullYear(), T.getMonth(), T.getDate() + i),
            k = `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`,
            l = evs(k)
              .map((e, j) => [e, j])
              .filter(
                (x) =>
                  (x[0].kind != "tx" || k > today) &&
                  !(
                    x[0].kind == "bill" &&
                    bPaid(S.bills.find((b) => b.id == x[0].id), k)
                  ),
              );
          if (l.length)
            h +=
              `<div class="eyebrow" style="margin:10px 0 2px">${dt.toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric" })}</div>` +
              l.map((x) => rowH(k, x[0], x[1])).join("");
        }
        return h || '<p class="m">Nothing upcoming.</p>';
      }
      function Activity() {
        const o = actOld().replace(
          new RegExp('<p><b>[^<]*</b> <span class="g">.*?entries</span></p>'),
          "",
        );
        if (sel) {
          const j = o.indexOf('<p><button class="pill'),
            i = o.lastIndexOf('<div class="card">');
          return (
            o.slice(0, j) +
            `<div class="card">${dayItems(sel)}<p><button class="btn s" onclick="openTx();$('#dt').value=sel">＋ Add entry on this date</button> <button class="btn s" onclick="sel='';render()">Clear date</button></p></div>` +
            o.slice(j, i)
          );
        }
        if (filt == "Upcoming") {
          const i = o.lastIndexOf('<div class="card">');
          return o.slice(0, i) + `${upGroups()}`;
        }
        const i2 = o.lastIndexOf('<div class="card">');
        return o.slice(0, i2) + actGroups();
      }
      function actList() {
        return [...S.tx]
          .sort((a, b) => b.d.localeCompare(a.d) || b.id - a.id)
          .filter((t) => filt == "All" || (filt == "Expenses" ? t.amt < 0 : t.amt > 0))
          .filter(
            (t) => !q || (t.note + (t.desc||"")+t.cat + Math.abs(t.amt)).toLowerCase().includes(q.toLowerCase()),
          );
      }
      function dlab(k) {
        return k == today
          ? "Today"
          : new Date(k + "T00:00:00").toLocaleDateString("en-PH", {
              weekday: "short",
              month: "short",
              day: "numeric",
            });
      }
      function grp(k, rows, right) {
        return `<div style="display:flex;justify-content:space-between;align-items:baseline;margin:18px 4px 6px"><b>${dlab(k)}</b><span class="m" style="font-size:13px">${right}</span></div><div class="card" style="padding:2px 14px">${rows}</div>`;
      }
      function rowT(t) {
        const k = t.d,
          j = evs(k).findIndex((e) => e.kind == "tx" && e.id == t.id);
        return `<div class="row" style="cursor:pointer" onclick="evDetail('${k}',${j})"><div class="ico">${ti(t)}</div><div class="f">${esc(t.note || t.cat)}${k > today ? '<span class="tag">Planned</span>' : ""}<small>${t.cat} · ${acct(t.acct).name}</small></div><b class="${t.amt > 0 ? "g" : "r"}">${t.amt > 0 ? "+" : ""}${php(t.amt)}</b><button class="pill dots" aria-label="Edit transaction" onclick="event.stopPropagation();editTx(${t.id})">${DOTS}</button></div>`;
      }
      function actGroups() {
        const l = actList(),
          g = {};
        l.forEach((t) => (g[t.d] = g[t.d] || []).push(t));
        return (
          Object.keys(g)
            .sort()
            .reverse()
            .map((k) => {
              const tot = sum(g[k].map((t) => t.amt));
              return grp(
                k,
                g[k].map(rowT).join(""),
                k > today ? "Planned" : (tot < 0 ? "−" : "+") + php(Math.abs(tot)),
              );
            })
            .join("") || '<p class="m">Nothing here yet.</p>'
        );
      }
      function upGroups() {
        let h = "";
        const p = (x) => String(x).padStart(2, "0");
        for (let i = 0; i < 45; i++) {
          const dt = new Date(T.getFullYear(), T.getMonth(), T.getDate() + i),
            k = `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`,
            l = evs(k)
              .map((e, j) => [e, j])
              .filter(
                (x) =>
                  (x[0].kind != "tx" || k > today) &&
                  !(
                    x[0].kind == "bill" &&
                    bPaid(S.bills.find((b) => b.id == x[0].id), k)
                  ),
              );
          if (l.length) h += grp(k, l.map((x) => rowH(k, x[0], x[1])).join(""), "Planned");
        }
        return h || '<p class="m">Nothing upcoming.</p>';
      }
      function calStats(Y, M) {
        const p = `${Y}-${String(M + 1).padStart(2, "0")}`,
          l = S.tx.filter((t) => t.d.startsWith(p)),
          i = sum(l.filter((t) => t.amt > 0).map((t) => t.amt)),
          o = -sum(l.filter((t) => t.amt < 0).map((t) => t.amt));
        return `<span class="g">+${php(i)}</span> <span class="m">·</span> <span class="r">−${php(o)}</span> <span class="m">· ${l.length} ${l.length == 1 ? "entry" : "entries"}</span>`;
      }
      function evDetail(k, j) {
        const e = evs(k)[j];
        if (!e) return;
        const tx = e.kind == "tx",
          o = tx
            ? S.tx.find((x) => x.id == e.id)
            : e.kind == "bill"
              ? S.bills.find((x) => x.id == e.id)
              : acct(e.id),
          key = e.kind == "bill" ? "al" : e.kind == "due" ? "alD" : "alS",
          col = { o: "#ff453a", i: "#30d158", s: "#ffd60a", u: "#ffd60a" }[e.c],
          ds = new Date(k + "T00:00:00").toLocaleDateString("en-PH", {
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
          }),
          al = o[key] || [1, 7, -1];
        openS(`<div style="display:flex;justify-content:flex-end;margin-bottom:6px"><button class="pill" onclick="closeS()">✕ Close</button></div><div style="display:flex;gap:12px;align-items:flex-start"><div style="width:5px;align-self:stretch;border-radius:9px;background:${col};flex:none"></div><div style="flex:1;min-width:0"><h2 style="font-size:26px;margin:0 0 6px">${tx ? o.note || o.cat : tt(e.t)}</h2><div>${ds}</div><div class="xmc">${tx ? (cardLogo(acct(o.acct)) || "") + `<span>${esc(acct(o.acct).name)} · ${esc(o.cat)}</span>` : "All-day"}</div>${tx && o.desc ? `<div class="m" style="margin-top:6px;overflow-wrap:anywhere">${esc(o.desc)}</div>` : ""}${tx ? `<div class="${o.amt > 0 ? "g" : "r"}" style="font-size:22px;font-weight:700">${php(o.amt)}</div>` : `<div class="m">🔁 Repeats monthly</div>${e.kind == "bill" ? `<div class="r" style="font-size:22px;font-weight:700">${php(o.amt)}</div>` : ""}`}</div><div class="xmi" aria-hidden="true">${tx ? ti(o) : e.kind == "bill" ? bIc(o) : (cardLogo(o) || "💳")}</div></div>
<div class="eyebrow" style="margin:18px 0 6px">Options</div><div class="card" style="display:flex;justify-content:space-between;margin-bottom:10px"><span>🗓 Calendar</span><span class="m"><span style="color:${col}">●</span> ${tx ? (o.amt > 0 ? "Income" : "Expenses") : e.kind == "bill" ? "Bills" : "Credit Card"}</span></div>
${tx ? "" : `<div class="card" style="margin-bottom:10px">${[0, 1, 2].map((i) => `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:4px 0">🔔 Alert<select style="width:auto;margin:0" onchange="setAl('${e.kind}',${e.id},${i},this.value)">${ALO.map((a) => `<option value="${a[0]}" ${al[i] == a[0] ? "selected" : ""}>${a[1]}</option>`).join("")}</select></div>`).join("")}<p class="m" style="font-size:12px;margin:6px 0 0">Alerts appear under "Needs attention" on Home as the date gets close. They are not phone notifications.</p></div>`}
${e.kind == "bill" && !bPaid(o, k) ? `<button class="btn" style="width:100%;margin-bottom:10px" onclick="payBill(${e.id},'${k}')">Mark as paid</button>` : ""}
${tx ? `<button class="btn s" style="width:100%;margin-bottom:8px" onclick="closeS();editTx(${e.id})">Edit transaction</button>` : ""}<button class="btn s" style="width:100%;color:#ff453a" onclick="${tx ? `askDel(${e.id})` : `sure(this,()=>evDel('${e.kind}',${e.id}))`}">${tx ? "Delete entry" : "Delete Event"}</button>`);
      }
      function setAl(kd, id, i, v) {
        const o = kd == "bill" ? S.bills.find((x) => x.id == id) : acct(id),
          key = kd == "bill" ? "al" : kd == "due" ? "alD" : "alS";
        (o[key] = o[key] || [1, 7, -1])[i] = +v;
        render();
      }
      function evDel(kd, id) {
        if (kd == "tx") delTx(id);
        else if (kd == "bill") S.bills = S.bills.filter((x) => x.id != id);
        else {
          const c = S.accts.find((x) => x.id == id);
          if (c) {
            if (kd == "due") {
              c.due = 0;
              c.dueN = 0;
            } else c.stmt = 0;
          }
        }
        closeS();
        render();
      }
      function actOld() {
        let l = [...S.tx]
          .sort((a, b) => b.d.localeCompare(a.d) || b.id - a.id)
          .filter((t) => filt == "All" || (filt == "Expenses" ? t.amt < 0 : t.amt > 0))
          .filter((t) => !sel || t.d == sel)
          .filter(
            (t) => !q || (t.note + (t.desc||"")+t.cat + Math.abs(t.amt)).toLowerCase().includes(q.toLowerCase()),
          );
        const m = mtx();
        return `<h1>Activity</h1><input id="activity-search" placeholder="Search title, description, category or amount" value="${esc(q)}" oninput="q=this.value;render();const i=$('#activity-search');i.focus();i.setSelectionRange(q.length,q.length)">
<p><b>${new Date().toLocaleDateString("en-PH", { month: "long", year: "numeric" })}</b> <span class="g">+${php(sum(m.filter((t) => t.amt > 0).map((t) => t.amt)))}</span> <span class="r">${php(-sum(m.filter((t) => t.amt < 0).map((t) => t.amt)))}</span> <span class="m">· ${m.length} entries</span></p>
${calH()}<p>${["All", "Expenses", "Income", "Upcoming"].map((f) => `<button class="pill ${f == filt ? "on" : ""}" onclick="filt='${f}';sel='';render()">${f}</button>`).join(" ")}</p>
<div class="card">${l.map((t) => `<div class="row"><div class="ico">${ti(t)}</div><div class="f">${t.note || t.cat}<small>${t.cat} · ${acct(t.acct).name} · ${t.d}</small></div><b class="${t.amt > 0 ? "g" : "r"}">${t.amt > 0 ? "+" : ""}${php(t.amt)}</b><button class="pill dots" aria-label="Edit transaction" onclick="editTx(${t.id})">${DOTS}</button></div>`).join("") || '<p class="m">Nothing here yet.</p>'}</div>`;
      }


      /* Shared sheets and transaction actions */
      function openS(h) {
        $("#sb").innerHTML = h;
        $("#sheet").classList.add("open");
      }
      function closeS() {
        $("#sheet").classList.remove("open");
      }
      function openTx(txId = 0) {
        const t = txId ? S.tx.find((x) => x.id == txId) : null;
        if (txId && !t) return;
        const val = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"),
          cats = Object.keys(CATS),
          cat = t ? t.cat : "Food";
        openS(
          `<h2>${t ? "Edit transaction" : "New entry"}</h2><select id="ty"><option value="-1" ${t && t.amt < 0 ? "selected" : ""}>Expense</option><option value="1" ${t && t.amt > 0 ? "selected" : ""}>Income</option></select><input id="am" type="number" min="0" step="0.01" placeholder="Amount (${CS()})" inputmode="decimal" value="${t ? Math.abs(t.amt) : ""}"><select id="ct">${cats.map((c) => `<option ${c == cat ? "selected" : ""}>${c}</option>`).join("")}</select><select id="ac">${S.accts.map((a) => `<option value="${a.id}" ${t && a.id == t.acct ? "selected" : ""}>${a.name}</option>`).join("")}</select><input id="dt" type="date" value="${t ? val(t.d) : today}"><input id="nt" placeholder="Title (e.g. Jollibee)" value="${t ? val(t.note || "") : ""}"><textarea id="ds" maxlength="300" placeholder="Description (e.g. Chickenjoy bucket for family dinner)">${t ? val(t.desc || "") : ""}</textarea><button class="btn" onclick="saveTx(${txId || 0})">Save</button> <button class="btn s" onclick="closeS()">Cancel</button>`,
        );
      }
      function editTx(id) {
        openTx(id);
      }
      function saveTx(txId = 0) {
        const a = Math.abs(+$("#am").value),
          s = +$("#ty").value,
          id = +$("#ac").value,
          ac = S.accts.find((x) => x.id == id),
          date = $("#dt").value || today;
        if (!Number.isFinite(a) || !a) return;
        let t = txId ? S.tx.find((x) => x.id == txId) : null;
        if (txId && !t) return;
        if (t) {
          const oldAc = S.accts.find((x) => x.id == t.acct);
          if (oldAc) oldAc.bal -= oldAc.type == "credit" ? -t.amt : t.amt;
        } else {
          t = { id: Date.now() + Math.floor(Math.random() * 1000) };
          S.tx.push(t);
        }
        t.d = date;
        t.amt = s * a;
        t.cat = $("#ct").value;
        t.acct = id;
        t.note = $("#nt").value;
        t.desc = $("#ds") ? $("#ds").value.trim() : "";
        if (ac) ac.bal += ac.type == "credit" ? -t.amt : t.amt;
        closeS();
        render();
      }
      function addTx() {
        saveTx();
      }
      function delTx(id) {
        const t = S.tx.find((x) => x.id == id);
        if (!t) return;
        const ac = S.accts.find((x) => x.id == t.acct);
        if (ac) ac.bal -= ac.type == "credit" ? -t.amt : t.amt;
        S.tx = S.tx.filter((x) => x.id != id);
        render();
      }


/* ---- transactions: posted / pending, edit, delete */
const fTx=id=>{let t=S.tx.find(x=>x.id==id);if(t)return{t,p:0};t=S.pend.find(x=>x.id==id);return t?{t,p:1}:null};
const bApply=(t,k)=>{const a=S.accts.find(x=>x.id==t.acct);if(a)a.bal+=k*(a.type=='credit'?-t.amt:t.amt)};
function openTx(txId=0){const f=txId?fTx(txId):null;if(txId&&!f)return;const t=f&&f.t,v=x=>String(x==null?'':x).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'),cat=t?t.cat:'Food',a0=t?t.acct:(S.accts[0]||{}).id;
openS(`<h2>${t?'Edit transaction':'New entry'}</h2><select id="ty"><option value="-1" ${t&&t.amt<0?'selected':''}>Expense</option><option value="1" ${t&&t.amt>0?'selected':''}>Income</option></select><input id="am" type="number" min="0" step="0.01" placeholder="Amount (${CS()})" inputmode="decimal" value="${t?Math.abs(t.amt):''}"><select id="ct">${Object.keys(CATS).map(c=>`<option ${c==cat?'selected':''}>${c}</option>`).join('')}</select><select id="ac" onchange="txAcc()">${S.accts.map(a=>`<option value="${a.id}" ${a.id==a0?'selected':''}>${esc(a.name)}</option>`).join('')}</select><input id="dt" type="date" value="${t?v(t.d):today}"><div id="ccf" style="display:none"><select id="ps" onchange="txAcc()"><option value="p" ${f&&f.p?'':'selected'}>Posted</option><option value="n" ${f&&f.p?'selected':''}>Not posted (pending)</option></select><input id="pdt" type="date" title="Posting date" value="${t&&t.pd?t.pd:(t?t.d:today)}"><p class="m" style="font-size:12px;margin:0 0 8px">Pending purchases stay out of balances and statements until posted. The posting date decides the billing cycle.</p></div><input id="nt" placeholder="Title (e.g. Jollibee)" value="${t?v(t.note||''):''}"><textarea id="ds" maxlength="300" placeholder="Description (e.g. Chickenjoy bucket for family dinner)">${t?v(t.desc||''):''}</textarea><button class="btn" onclick="saveTx(${txId||0})">Save</button> <button class="btn s" onclick="closeS()">Cancel</button>${txId?`<button class="btn s dng" onclick="askDel(${txId})">Delete transaction</button>`:''}`);txAcc()}
function txAcc(){const c=acct($('#ac').value).type=='credit';$('#ccf').style.display=c?'block':'none';$('#pdt').style.display=c&&$('#ps').value=='p'?'block':'none'}
function saveTx(txId=0){const a=Math.abs(+$('#am').value),s=+$('#ty').value,id=+$('#ac').value,ac=S.accts.find(x=>x.id==id),date=$('#dt').value||today;
if(!(a>0))return toast('Enter an amount greater than 0');if(!ac)return toast('Choose an account');
const pend=ac.type=='credit'&&$('#ps').value=='n',pd=ac.type=='credit'&&!pend?($('#pdt').value||date):'';
if(pd&&pd<date)return toast('Posting date can’t be before the purchase date');
const f=txId?fTx(txId):null;if(txId&&!f)return;if(f&&!f.p)bApply(f.t,-1);
const t=f?f.t:{id:uid()};S.tx=S.tx.filter(x=>x.id!=t.id);S.pend=S.pend.filter(x=>x.id!=t.id);
Object.assign(t,{d:date,amt:s*a,cat:$('#ct').value,acct:id,note:$('#nt').value,desc:($('#ds')?$('#ds').value.trim():'')});if(pd)t.pd=pd;else delete t.pd;
(pend?S.pend:S.tx).push(t);if(!pend)bApply(t,1);closeS();flash(t.id);render();toast(txId?'Transaction updated':pend?'Saved as pending':'Transaction added')}
function delTx(id){const f=fTx(id);if(!f)return;const go=()=>{if(!f.p)bApply(f.t,-1);S.tx=S.tx.filter(x=>x.id!=id);S.pend=S.pend.filter(x=>x.id!=id);render();toast('Transaction deleted')},e=document.querySelector(`[data-tx="${id}"]`);if(e&&!matchMedia('(prefers-reduced-motion:reduce)').matches){e.classList.add('out');setTimeout(go,260)}else go()}

/* ---- delete confirmation dialog */
function confirmBox(title,sub,ok){
  let o=document.getElementById('cfm');if(o)o.remove();
  o=document.createElement('div');o.id='cfm';o.setAttribute('role','alertdialog');o.setAttribute('aria-modal','true');o.setAttribute('aria-labelledby','cfm-t');
  o.innerHTML='<div class="cfm-box"><h3 id="cfm-t"></h3><p class="m cfm-s"></p><div class="cfm-b"><button class="btn dng-f" id="cfm-ok">Confirm</button><button class="btn s" id="cfm-no">Cancel</button></div></div>';
  o.querySelector('#cfm-t').textContent=title;const sp=o.querySelector('.cfm-s');if(sub)sp.textContent=sub;else sp.remove();
  document.body.appendChild(o);
  let done=0;const close=cb=>{if(done)return;done=1;document.removeEventListener('keydown',kd,true);o.classList.add('closing');setTimeout(()=>{o.remove();cb&&cb()},matchMedia('(prefers-reduced-motion:reduce)').matches?0:190)};
  const kd=e=>{if(e.key=='Escape'){e.stopPropagation();close()}};
  document.addEventListener('keydown',kd,true);
  o.addEventListener('click',e=>{if(e.target===o)close()});
  o.querySelector('#cfm-no').onclick=()=>close();
  o.querySelector('#cfm-ok').onclick=()=>close(ok);
  requestAnimationFrame(()=>{o.classList.add('open');o.querySelector('#cfm-no').focus({preventScroll:true})});
}
function askDel(id){const f=fTx(id);if(!f)return;confirmBox('Are you sure you want to delete?',(f.t.note||f.t.cat)+' · '+php(f.t.amt),()=>{closeS();delTx(id)})}

/* ---- long-press a transaction to open its edit sheet */
(function(){
  const MS=450,MOVE=10;let st=null;
  const stop=()=>{if(!st)return;clearTimeout(st.t);st.el.classList.remove('lp');st=null};
  document.addEventListener('pointerdown',e=>{
    if(e.button>0||st)return;
    const el=e.target.closest&&e.target.closest('.row[data-tx]');
    if(!el||e.target.closest('button,a,input,select,textarea,label'))return;
    const id=el.getAttribute('data-tx');
    st={el,x:e.clientX,y:e.clientY,t:setTimeout(()=>{
      window._lp=Date.now();el.classList.remove('lp');void el.offsetWidth;el.classList.add('lp-done');
      setTimeout(()=>el.classList.remove('lp-done'),340);
      if(navigator.vibrate)try{navigator.vibrate(14)}catch(_){}
      st=null;editTx(+id)
    },MS)};
    el.classList.add('lp');
  },true);
  document.addEventListener('pointermove',e=>{if(st&&Math.hypot(e.clientX-st.x,e.clientY-st.y)>MOVE)stop()},true);
  ['pointerup','pointercancel','pointerleave','dragstart'].forEach(t=>document.addEventListener(t,()=>stop(),true));
  window.addEventListener('scroll',stop,true);
  document.addEventListener('contextmenu',e=>{if(e.target.closest&&e.target.closest('.row[data-tx]'))e.preventDefault()},true);
  document.addEventListener('click',e=>{if(Date.now()-(window._lp||0)<700){e.stopPropagation();e.preventDefault()}},true);
})();
/* ---- long-press (or right-click / Enter) a bill or subscription on Home to edit it */
(function(){
  const MS=450,MOVE=10,SEL='.row[data-bill],.row[data-bcard]';let st=null;
  const open=el=>{const b=el.getAttribute('data-bill'),c=el.getAttribute('data-bcard');if(b)editBillSheet(+b);else if(c)cardPayInfo(+c)};
  const stop=()=>{if(!st)return;clearTimeout(st.t);st.el.classList.remove('lp');st=null};
  document.addEventListener('pointerdown',e=>{
    if(e.button>0||st)return;
    const el=e.target.closest&&e.target.closest(SEL);
    if(!el||e.target.closest('button,a,input,select,textarea,label'))return;
    st={el,x:e.clientX,y:e.clientY,t:setTimeout(()=>{
      window._lp=Date.now();el.classList.remove('lp');void el.offsetWidth;el.classList.add('lp-done');
      setTimeout(()=>el.classList.remove('lp-done'),340);
      if(navigator.vibrate)try{navigator.vibrate(14)}catch(_){}
      st=null;open(el)
    },MS)};
    el.classList.add('lp');
  },true);
  document.addEventListener('pointermove',e=>{if(st&&Math.hypot(e.clientX-st.x,e.clientY-st.y)>MOVE)stop()},true);
  ['pointerup','pointercancel','pointerleave','dragstart'].forEach(t=>document.addEventListener(t,()=>stop(),true));
  window.addEventListener('scroll',stop,true);
  document.addEventListener('contextmenu',e=>{
    const el=e.target.closest&&e.target.closest(SEL);if(!el)return;
    e.preventDefault();
    if(Date.now()-(window._lp||0)>700){stop();open(el)} /* desktop right-click / context-menu key; touch long-press already opened it */
  },true);
  document.addEventListener('keydown',e=>{
    if((e.key==='Enter'||e.key===' ')&&e.target.matches&&e.target.matches(SEL)){e.preventDefault();open(e.target)}
  });
})();
function postTx(id){const f=fTx(id);if(!f||!f.p)return;openS(`<h2>Mark as posted</h2><p class="m">${esc(f.t.note||f.t.cat)} · ${php(f.t.amt)}</p><label class="m">Posting date (decides the billing cycle)</label><input id="pdx" type="date" min="${f.t.d}" value="${today<f.t.d?f.t.d:today}"><button class="btn" onclick="postOk(${id})">Confirm posted</button> <button class="btn s" onclick="closeS()">Cancel</button>`)}
function postOk(id){const f=fTx(id),pd=$('#pdx').value;if(!f||!f.p)return;if(!pd||pd<f.t.d)return toast('Enter a valid posting date');S.pend=S.pend.filter(x=>x.id!=id);f.t.pd=pd;S.tx.push(f.t);bApply(f.t,1);closeS();flash(id);render();toast('Posted · balance updated')}
function rowT(t){const k=t.d,p=S.pend.includes(t),j=evs(k).findIndex(e=>e.kind=='tx'&&e.id==t.id);return`<div class="row" data-tx="${t.id}" style="cursor:pointer" onclick="${p?`editTx(${t.id})`:`evDetail('${k}',${j})`}"><div class="ico">${ti(t)}</div><div class="f">${esc(t.note||t.cat)}${k>today?'<span class="tag">Planned</span>':''}${p?'<span class="tag">Pending</span>':''}<small>${t.cat} · ${esc(acct(t.acct).name)}${t.pd&&t.pd!=t.d?' · Posted '+noteD(t.pd):''}</small>${t.desc?`<small class="dsc">${esc(t.desc)}</small>`:''}</div><b class="${t.amt>0?'g':'r'}">${t.amt>0?'+':''}${php(t.amt)}</b>${p?`<button class="pill" onclick="event.stopPropagation();postTx(${t.id})">Post</button>`:''}<button class="pill dots" aria-label="Edit transaction" onclick="event.stopPropagation();editTx(${t.id})">${DOTS}</button></div>`}
function actGroups(){const l=actList(),g={};l.forEach(t=>(g[t.d]=g[t.d]||[]).push(t));
const pl=S.pend.filter(t=>(filt=='All'||(filt=='Expenses'?t.amt<0:t.amt>0))&&(!q||(t.note+(t.desc||"")+t.cat+Math.abs(t.amt)).toLowerCase().includes(q.toLowerCase()))).sort((a,b)=>b.d.localeCompare(a.d)),
ph=pl.length?`<div style="display:flex;justify-content:space-between;margin:18px 4px 6px"><b>Pending · not posted</b><span class="m" style="font-size:13px">${pl.length} · not in balances</span></div><div class="card" style="padding:2px 14px">${pl.map(rowT).join('')}</div>`:'';
return ph+(Object.keys(g).sort().reverse().map(k=>{const tot=sum(g[k].map(t=>t.amt));return grp(k,g[k].map(rowT).join(''),k>today?'Planned':(tot<0?'−':'+')+php(Math.abs(tot)))}).join('')||(ph?'':'<p class="m">Nothing here yet.</p>'))}


function initTransactionV2() {

(function(){
const P2=x=>String(x).padStart(2,'0'),isoD=d=>`${d.getFullYear()}-${P2(d.getMonth()+1)}-${P2(d.getDate())}`,addD=(d,n)=>new Date(d.getFullYear(),d.getMonth(),d.getDate()+n);
const rows=()=>[...S.tx,...(S.pend||[])],rxe=s=>String(s).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

/* ===== soft refresh: keeps search + calendar mounted, only swaps the list ===== */
window.soft=function(){
  const app=document.getElementById('app'),w=document.getElementById('calwrap'),inp=document.getElementById('activity-search');
  if(tab!='Activity'||!w||!inp){render();return}
  const t=document.createElement('div');t.innerHTML=Activity();const nw=t.querySelector('#calwrap');if(!nw){render();return}
  w.querySelectorAll('.dc').forEach(c=>c.classList.toggle('sel',c.dataset.k==sel));
  const a=[...w.querySelectorAll('p')].pop(),b=[...nw.querySelectorAll('p')].pop();
  if(a&&b&&a.innerHTML!==b.innerHTML)a.innerHTML=b.innerHTML;
  while(w.nextSibling)w.nextSibling.remove();
  let n=nw.nextSibling,i=0;
  while(n){const x=n.nextSibling;if(n.nodeType==1){n.classList.add('cap-in');n.style.setProperty('--i',Math.min(i++,6))}app.appendChild(n);n=x}
};
window.pickDay=k=>{sel=sel==k?'':k;soft()};
const calH0=calH;
window.calH=function(){return calH0.apply(this,arguments).replace(/<div class="(x?)" onclick="sel=sel=='([\d-]+)'\?'':'\2';render\(\)" style="[^"]*">/g,(m,x,k)=>`<div class="dc ${x}${k==sel?' sel':''}" data-k="${k}" onclick="pickDay('${k}')">`)};
const Act0=Activity;
window.Activity=function(){return Act0.apply(this,arguments).replace(/sel='';render\(\)/g,"sel='';soft()")};

/* ===== search dropdown ===== */
const hl=(t,v)=>{t=String(t);const i=v?t.toLowerCase().indexOf(v):-1;return i<0?esc(t):esc(t.slice(0,i))+'<mark>'+esc(t.slice(i,i+v.length))+'</mark>'+esc(t.slice(i+v.length))};
function items(v){
  v=v.trim().toLowerCase();const L=rows(),out=[];
  const cs=Object.keys(CATS).map(c=>({c,n:L.filter(t=>t.cat==c).length})).filter(x=>v?x.c.toLowerCase().includes(v):x.n).sort((a,b)=>b.n-a.n).slice(0,v?4:6);
  if(cs.length)out.push({h:'Categories'},...cs.map(x=>({ic:ci(x.c),l:hl(x.c,v),s:x.n+(x.n==1?' entry':' entries'),val:x.c})));
  const seen={},ns=[];[...L].sort((a,b)=>b.d.localeCompare(a.d)).forEach(t=>{const n=String(t.note||'').trim(),k=n.toLowerCase();if(!n)return;if(!seen[k]){seen[k]={t,n:0};ns.push(seen[k])}seen[k].n++});
  const nm=ns.filter(x=>!v||x.t.note.toLowerCase().includes(v)).slice(0,v?5:4);
  if(nm.length)out.push({h:v?'Notes':'Recent'},...nm.map(x=>({ic:ti(x.t),l:hl(x.t.note,v),s:x.n>1?x.n+' entries':php(x.t.amt),val:x.t.note})));
  if(/^\d/.test(v)){const am={};L.forEach(t=>{const a=String(Math.abs(t.amt));if(a.startsWith(v)&&!am[a])am[a]=t});
    const l=Object.entries(am).slice(0,4);if(l.length)out.push({h:'Amounts'},...l.map(([a,t])=>({ic:'₱',l:hl(a,v),s:t.note||t.cat,val:a})))}
  if(!out.length)out.push({e:1});
  return out;
}
function setupSearch(){
  const i=document.getElementById('activity-search');if(!i||i.dataset.v2)return;i.dataset.v2=1;
  i.removeAttribute('oninput');i.setAttribute('autocomplete','off');
  const wrap=document.createElement('div');wrap.className='sr-wrap';i.before(wrap);wrap.appendChild(i);
  const dd=document.createElement('div');dd.className='sr-dd';dd.setAttribute('role','listbox');wrap.appendChild(dd);
  let cur=-1,ft;
  const fill=()=>{let k=0;dd.innerHTML=items(i.value).map(x=>x.h?`<div class="sr-h">${x.h}</div>`:x.e?'<div class="sr-empty">No matches — press Enter to search anyway</div>':`<button type="button" class="sr-i" style="--i:${k++}" data-v="${esc(x.val)}"><span class="sr-ic">${x.ic}</span><span class="sr-t">${x.l}</span><small>${esc(x.s)}</small></button>`).join('');cur=-1};
  const open=()=>{if(!dd.classList.contains('open')){fill();dd.classList.add('fresh','open');clearTimeout(ft);ft=setTimeout(()=>dd.classList.remove('fresh'),500)}};
  const close=()=>dd.classList.remove('open');
  const pick=v=>{i.value=v;q=v;soft();close();i.blur()};
  i.addEventListener('focus',open);i.addEventListener('click',open);
  i.addEventListener('input',()=>{q=i.value;soft();if(dd.classList.contains('open'))fill();else open()});
  i.addEventListener('keydown',e=>{const L=[...dd.querySelectorAll('.sr-i')];
    if(e.key=='ArrowDown'||e.key=='ArrowUp'){e.preventDefault();open();if(!L.length)return;cur=(cur+(e.key=='ArrowDown'?1:-1)+L.length)%L.length;L.forEach((x,j)=>x.classList.toggle('on',j==cur));L[cur].scrollIntoView({block:'nearest'})}
    else if(e.key=='Enter'){if(cur>=0&&L[cur])pick(L[cur].dataset.v);else{close();i.blur()}}
    else if(e.key=='Escape')close()});
  dd.addEventListener('pointerdown',e=>e.preventDefault());
  dd.addEventListener('click',e=>{const b=e.target.closest('.sr-i');if(b)pick(b.dataset.v)});
  if(!window._srDoc){window._srDoc=1;document.addEventListener('pointerdown',e=>{if(!e.target.closest('.sr-wrap')){const d=document.querySelector('.sr-dd');d&&d.classList.remove('open')}},true)}
}
const r0=render;window.render=function(){const r=r0.apply(this,arguments);setupSearch();return r};
setupSearch();

/* ===== smarter "Log anything" ===== */
const STOP=new Set('the and for with via using use thru through from paid pay payment charged charge bought buy spent spend at on in to of my an by using'.split(' '));
const MO={jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,sept:8,oct:9,nov:10,dec:11},WD=['sun','mon','tue','wed','thu','fri','sat'];
const MR='(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\\.?';
function parseDate(s){
  const T0=new Date(today+'T00:00:00'),Y=T0.getFullYear();let m,d=null;
  const cut=()=>{s=s.replace(m[0],' ')};
  if(m=s.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/)){d=new Date(+m[1],+m[2]-1,+m[3]);cut()}
  else if(m=s.match(new RegExp('\\b'+MR+'\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b','i'))){d=new Date(m[3]?+m[3]:Y,MO[m[1].toLowerCase()],+m[2]);cut()}
  else if(m=s.match(new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+'+MR+'(?:,?\\s+(\\d{4}))?\\b','i'))){d=new Date(m[3]?+m[3]:Y,MO[m[2].toLowerCase()],+m[1]);cut()}
  else if(m=s.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/)){const y=m[3]?(+m[3]<100?2000+ +m[3]:+m[3]):Y;d=new Date(y,+m[1]-1,+m[2]);cut()}
  else if(m=s.match(/\b(yesterday|kahapon)\b/i)){d=addD(T0,-1);cut()}
  else if(m=s.match(/\b(today|tonight|ngayon)\b/i)){d=T0;cut()}
  else if(m=s.match(/\b(tomorrow|bukas)\b/i)){d=addD(T0,1);cut()}
  else if(m=s.match(/\b(\d+)\s+days?\s+ago\b/i)){d=addD(T0,-m[1]);cut()}
  else if(m=s.match(/\b(last\s+|on\s+|this\s+)?(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/i)){const w=WD.indexOf(m[2].toLowerCase());let df=(T0.getDay()-w+7)%7;if(df==0&&/last/i.test(m[1]||''))df=7;d=addD(T0,-df);cut()}
  return{d:d&&!isNaN(d)?isoD(d):today,s,found:!!d};
}
const ali=a=>{const p=String(a.bank||'').split(/(?=[A-Z])|\s+/).filter(Boolean);return p.length>1?p.map(w=>w[0]).join('').toLowerCase():''};
const nz=x=>String(x||'').toLowerCase().replace(/[^a-z0-9]/g,'');
function findAcct(s){
  const qn=nz(s);let top=0,hit=[];
  S.accts.forEach(a=>{const nn=nz(a.name),bn=nz(a.bank);let sc=0;
    if(nn.length>2&&qn.includes(nn))sc=3;else if(bn.length>1&&qn.includes(bn))sc=2;
    else if(ali(a)&&new RegExp('\\b'+ali(a)+'\\b','i').test(s))sc=2;
    else if(a.l4&&new RegExp('(^|\\D)'+a.l4+'(\\D|$)').test(s))sc=2;
    if(sc&&sc>=top){if(sc>top){top=sc;hit=[]}hit.push(a)}});
  if(!hit.length)return null;
  const tw=/\b(credit|cc)\b/i.test(s)?'credit':/\bdebit\b/i.test(s)?'debit':/\b(e-?wallet|wallet)\b/i.test(s)?'ewallet':'';
  let c=tw?hit.filter(a=>a.type==tw):[];if(!c.length)c=hit;
  c.sort((a,b)=>rows().filter(t=>t.acct==b.id).length-rows().filter(t=>t.acct==a.id).length);return c[0];
}
const spaced=w=>String(w).toLowerCase().split('').filter(c=>/[a-z0-9]/.test(c)).map(rxe).join('[\\s\\-]*');
const KW={Food:/(food|lunch|dinner|breakfast|coffee|starbucks|jollibee|mcdo|kfc|chowking|snack|restaurant|milk ?tea|grabfood|foodpanda|pizza|burger)/,Groceries:/(grocer|puregold|supermarket|palengke|market|landers|s&r|walter ?mart)/,Transport:/(grab|jeep|mrt|lrt|taxi|gas|fuel|angkas|toll|parking|commute|uber|bus|fare)/,Bills:/(meralco|electric|water|pldt|globe|smart|converge|internet|rent|bill|load|insurance|tuition)/,Shopping:/(shopee|lazada|mall|clothes|shoes|shopping|zalora|uniqlo|amazon)/,Health:/(pharmacy|mercury|watsons|doctor|medicine|clinic|hospital|dental|vitamin|gym)/,Entertainment:/(netflix|spotify|youtube|disney|hbo|prime video|apple music|icloud|movie|cinema|game|steam|concert|ticket)/};
function guess(note,low,inc){
  const has=c=>Object.prototype.hasOwnProperty.call(CATS,c);
  if(inc)return{cat:has('Salary')?'Salary':'Other'};
  for(const c of Object.keys(CATS)){if(c=='Other'||c=='Salary')continue;if(new RegExp('(^|[^a-z])'+rxe(c.toLowerCase())+'($|[^a-z])').test(low))return{cat:c,rm:c}}
  const ws=note.toLowerCase().split(/[^a-z0-9]+/).filter(w=>w.length>2&&!STOP.has(w)),vc={},va={};
  rows().filter(t=>t.amt<0).forEach(t=>{const tw=String(t.note||'').toLowerCase().split(/[^a-z0-9]+/);ws.forEach(w=>{if(tw.includes(w)){vc[t.cat]=(vc[t.cat]||0)+1;va[t.acct]=(va[t.acct]||0)+1}})});
  const bc=Object.keys(vc).filter(has).sort((a,b)=>vc[b]-vc[a])[0],ba=Object.keys(va).sort((a,b)=>va[b]-va[a])[0];
  const k=Object.keys(KW).find(c=>has(c)&&KW[c].test(low));
  return{cat:bc||k||'Other',hacct:ba?+ba:null};
}
window.localLog=function(q){
  const t0=q.trim();
  if(!/\d/.test(t0)||/\?$/.test(t0)||/^(how|what|when|why|where|show|am i|can|do|did|is|are|which)\b/i.test(t0))
    return{reply:'Type what you spent or earned with an amount, like "Spotify 149 Maribank credit", "lunch 250 yesterday" or "salary 20000 BDO".',ids:[]};
  let s=' '+t0.replace(/(\d),(?=\d{3})/g,'$1').replace(/₱|\bphp\b/gi,' ').replace(/\bp(?=\s*\d)/gi,' ')+' ';
  const pd=parseDate(s);s=pd.s;
  const ac=findAcct(s);
  if(ac){[ac.name,ac.bank].forEach(w=>{s=s.replace(new RegExp(spaced(w),'ig'),' ')});if(ali(ac))s=s.replace(new RegExp('\\b'+ali(ac)+'\\b','ig'),' ');if(ac.l4)s=s.replace(new RegExp('(^|\\D)'+ac.l4+'(?=\\D|$)','g'),'$1 ');s=s.replace(/\b(credit|debit|cc|card|e-?wallet|wallet|account|acct)\b/ig,' ')}
  const m=s.match(/(\d+(?:\.\d+)?)\s*(k\b)?/i);
  if(!m)return{reply:'I couldn\'t find an amount. Try "Spotify 149".',ids:[]};
  const amt=+m[1]*(m[2]?1000:1);s=s.replace(m[0],' ');
  const low=s.toLowerCase(),inc=/\b(salary|paycheck|payroll|sweldo|received|income|refund|deposit|bonus|allowance|cashback|got paid)\b/.test(low)||/^\s*\+/.test(t0);
  const g0=guess(s,low,inc);if(g0.rm)s=s.replace(new RegExp('\\b'+rxe(g0.rm)+'\\b','ig'),' ');
  let note=s.replace(/\+/g,' ').split(/\s+/).filter(w=>w&&!STOP.has(w.toLowerCase())).join(' ').replace(/^[^\w]+|[^\w)]+$/g,'').trim();
  if(note&&note==note.toLowerCase())note=note.replace(/\b[a-z]/g,c=>c.toUpperCase());
  const acct=ac||S.accts.find(a=>a.id==g0.hacct)||S.accts[0],cat=g0.cat;
  const id=addEntry({type:inc?'income':'expense',amount:amt,category:cat,note:note||cat,account_id:acct?acct.id:null,date:pd.d});
  if(!id)return{reply:'That amount is zero, so nothing was logged. Try "'+(note||'Lunch')+' 250".',ids:[]};
  return{reply:`Logged ${inc?'income':'expense'} ${php(amt)}\n${note||cat} · ${cat}\n${acct?acct.name:'No account'} · ${dlab(pd.d)}${ac?'':'\n(Add a card name to pick another account, e.g. "'+(note||'Spotify')+' '+amt+' '+(S.accts[1]||S.accts[0]||{name:'BDO'}).name+'".)'}`,ids:id?[id]:[]};
};
})();

}


function initTransactionNoSelection() {

/* Blocks selection start, the context menu and image/link drag on transaction rows and the
   transaction detail sheet. Everything else in the app keeps normal text selection. */
(function(){
  if(window.__nosel)return;window.__nosel=1;
  const SEL='.row[data-tx],#sb.nosel';
  const hit=n=>{const el=n&&(n.nodeType===1?n:n.parentElement);
    return !!(el&&el.closest&&el.closest(SEL)&&!el.closest('input,textarea,select'));};
  const stop=e=>{if(hit(e.target)){e.preventDefault();}};
  document.addEventListener('selectstart',stop,true);
  document.addEventListener('contextmenu',stop,true);
  document.addEventListener('dragstart',stop,true);
  /* drop any highlight that slipped in (e.g. from a long press that began before the handlers ran) */
  document.addEventListener('selectionchange',function(){
    const s=window.getSelection&&getSelection();
    if(s&&!s.isCollapsed&&(hit(s.anchorNode)||hit(s.focusNode)))s.removeAllRanges();
  });
  /* the transaction detail sheet reuses #sb: mark it while it shows a transaction */
  const openS=window.openS,evDetail=window.evDetail;
  if(typeof openS==='function')window.openS=function(){const sb=document.getElementById('sb');if(sb)sb.classList.remove('nosel');return openS.apply(this,arguments);};
  if(typeof evDetail==='function')window.evDetail=function(k,j){
    const r=evDetail.apply(this,arguments);
    try{const e=window.evs&&evs(k)[j];if(e&&e.kind==='tx'){const sb=document.getElementById('sb');if(sb)sb.classList.add('nosel');}}catch(_){}
    return r;};
})();

}
