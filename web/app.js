'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = (name, cls='') => `<img class="icon ${esc(cls)}" src="/assets/icons/${encodeURIComponent(name)}.svg" alt="" aria-hidden="true" width="19" height="19">`;
const labels={not_run:'未执行',idle:'待运行',running:'执行中',queued:'排队中',success:'签到成功',already_checked:'今日已签到',synced:'余额已同步',manual_required:'需要处理',failed:'执行失败',interrupted:'已中断'};
const state={data:null,auth:null,currency:'USD',view:'overview',filter:'all',query:'',logFilter:'all',editing:null,busy:false,loginMethod:'session',loginSession:null,reauth:false,connecting:null,targetProvider:null,selectedProviders:[],loginQueue:null,refreshing:false,authorizationChecked:false};
const allProviders=()=>state.data?.providers||[];
const providers=()=>allProviders().filter(p=>p.active!==false);
const providerName=id=>esc(allProviders().find(p=>p.id===id)?.name||id||'未知平台');
const isOAuth=method=>['github','linuxdo'].includes(method);
const isBrowser=method=>isOAuth(method)||method==='manual';
const userBrowserAuthorization=()=>['manual','user_browser'].includes(state.data?.web?.authorization_mode);
const currencyLabel=unit=>unit?.startsWith('credits:')?`${providerName(unit.slice(8))} · 积分`:({USD:'USD',CNY:'CNY',credits:'积分'}[unit]||'USD');
const money=(n,unit='USD')=>n==null?'<span class="unknown-money">待同步</span>':`${unit==='CNY'?'¥':unit.startsWith('credits')?'':'$'}${Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}${unit.startsWith('credits')?' 积分':''}`;
const authLabel=a=>(a.auth_mode==='password'?'账号密码':a.login_via==='github'?'GitHub 授权':a.login_via==='linuxdo'?'LinuxDO 授权':a.login_via==='manual'?'手填 Session':'Session')+`<small class="account-proxy">${a.proxy?.mode==='custom'?'自定义代理':a.proxy?.mode==='direct'?'直连':'默认网络'}</small>`;
let toastTimer,loginPoll,refreshTimer,modalTrigger;
const credentialRequests=new WeakMap();
const ACCOUNT_BACKUP_MAX_BYTES=8*1024*1024;
let accountFileTransfer=null;
function toast(message){const el=$('#toast');el.textContent=message;el.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('show'),4000);}
function connectionStatus(online){const el=$('#connection'),value=online?'online':'offline';el.classList.toggle('offline',!online);if(el.dataset.connection!==value){el.dataset.connection=value;el.innerHTML=`<i aria-hidden="true"></i>${online?'服务已连接':'连接中断'}`;}$('#connection-error').hidden=online;}
async function api(path,options={}){
 const method=options.method||'GET';
 const csrf=state.data?.csrf_token||state.auth?.csrf_token;
 const response=await fetch(path,{method,headers:method==='GET'?{}:{'Content-Type':'application/json',...(csrf?{'X-CSRF-Token':csrf}:{})},body:options.body?JSON.stringify(options.body):undefined,signal:options.signal,credentials:'same-origin',cache:'no-store'});
 if(!response.ok){let message='请求未完成';try{const body=await response.json();message=typeof body.detail==='string'?body.detail:'请检查填写内容';}catch{}const error=new Error(message);error.status=response.status;error.definitive=response.status>=400&&response.status<500;if(response.status===401&&!path.startsWith('/api/auth/')){await returnToLogin();}throw error;}
 return response.json();
}
async function refresh(silent=false){
 if(state.refreshing||state.auth?.authenticated===false)return;
 state.refreshing=true;
 try{state.data=await api('/api/bootstrap');connectionStatus(true);render();syncAccountTransfer(accountFileTransfer);if(!state.authorizationChecked){state.authorizationChecked=true;restoreAuthorization(state.data.authorization);}}
 catch(error){if(error.status!==401){connectionStatus(false);if(!silent)toast('无法连接服务，请检查网络后重新连接。');}}
 finally{state.refreshing=false;}
}
function timeLabel(value,date=false){
 if(!value)return '尚未执行';const d=new Date(value);if(Number.isNaN(d.getTime()))return '时间未知';const diff=d-Date.now();
 if(!date&&diff>0&&diff<86400000){const h=Math.floor(diff/3600000),m=Math.max(1,Math.floor(diff%3600000/60000));return h?`${h} 小时 ${m} 分后`:`${m} 分钟后`;}
 const options={month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false};if(state.data?.web?.timezone)options.timeZone=state.data.web.timezone;
 try{return d.toLocaleString('zh-CN',options);}catch{delete options.timeZone;return d.toLocaleString('zh-CN',options);}
}
function nextRun(){return state.data.accounts.filter(a=>a.enabled&&a.next_run).sort((a,b)=>a.next_run.localeCompare(b.next_run))[0];}
function currencyPicker(){
 const units=Object.keys(state.data.amounts||{USD:{}});
 if(!units.includes(state.currency))state.currency=units[0]||'USD';
 return `<div class="overview-context"><span class="context-caption">${icon('calendar')}今日概览</span><label class="currency-picker" for="currency-picker">额度单位<select id="currency-picker" class="currency-select" aria-label="切换额度单位">${units.map(unit=>`<option value="${esc(unit)}" ${unit===state.currency?'selected':''}>${currencyLabel(unit)}</option>`).join('')}</select></label></div>`;
}
function stats(){
 const s={...state.data.stats,...state.data.amounts?.[state.currency]},accounts=state.data.accounts,n=accounts.length;
 const attention=accounts.filter(a=>['manual_required','failed','interrupted'].includes(a.status)).length;
 return `<section class="balance-overview" aria-label="额度与今日运行汇总">
  <article class="metric-card balance-main"><div class="metric-label">当前总余额<span class="metric-icon">${icon('wallet')}</span></div><div class="metric-value balance-number">${money(s.balance,state.currency)}</div><div class="metric-note">已同步账号 · ${currencyLabel(state.currency)}</div></article>
  <article class="metric-card"><div class="metric-label">今日已领取<span class="metric-icon">${icon('trend')}</span></div><div class="metric-value positive">${money(s.today_reward,state.currency)}</div><div class="metric-note">仅计入可确认的新增额度</div></article>
  <article class="metric-card"><div class="metric-label">今日已完成<span class="metric-icon">${icon('check')}</span></div><div class="metric-value">${s.today_completed||0}<small>/ ${n}</small></div><div class="metric-note">签到成功、已签到或余额同步</div></article>
  <article class="metric-card"><div class="metric-label">需要处理<span class="metric-icon">${icon('shield')}</span></div><div class="metric-value ${attention?'attention-value':''}">${attention}<small>个账号</small></div><div class="metric-note">${attention?'检查凭据或查看运行日志':n?'暂无异常运行状态':'添加账号后开始管理'}</div></article>
 </section>`;
}
function chart(){
 const trend=state.data.trends?.[state.currency]||state.data.trend||[],max=Math.max(1,...trend.map(t=>t.reward||0)),has=trend.some(t=>t.runs),total=trend.reduce((sum,t)=>sum+(t.reward||0),0);
 return `<section class="panel chart-panel"><div class="panel-head"><div><h2 class="panel-title">额度趋势</h2><p class="panel-sub">最近 7 天的可确认新增额度</p></div><span class="chart-legend"><i></i>${currencyLabel(state.currency)}</span></div>
  <div class="chart-summary"><div class="chart-total">${money(total,state.currency)}</div><span class="chart-summary-note">7 天累计</span></div>
  <div class="chart-wrap"><div class="chart-grid" aria-hidden="true"><i></i><i></i><i></i></div><div class="chart-plot"><div class="chart-y" aria-hidden="true"><span>${max.toFixed(max<10?1:0)}</span><span>${(max/2).toFixed(max<10?1:0)}</span><span>0</span></div><div class="chart-bars">${trend.map((t,i)=>`<div class="bar-day ${i===trend.length-1?'today':''}" tabindex="0" aria-label="${esc(t.date)}：新增 ${Number(t.reward||0).toFixed(2)} ${currencyLabel(state.currency)}，${t.runs||0} 次运行"><div class="bar-track"><div class="bar ${t.reward?'':'zero'}" style="height:${t.reward?Math.max(3,t.reward/max*88):2}%">${t.reward?`<span class="bar-number" aria-hidden="true">${Number(t.reward).toLocaleString('en-US',{maximumFractionDigits:2})}</span>`:''}<span class="bar-value">${money(t.reward,state.currency)}<small>${t.runs||0} 次运行</small></span></div></div><span class="bar-date">${i===trend.length-1?'今天':esc(t.date.slice(-5).replace('-','/'))}</span></div>`).join('')}</div></div>${has?'':`<div class="chart-empty">${icon('trend')}<b>额度变化，从第一次运行开始</b><span>添加账号并完成签到，这里会记录每天的结果。</span></div>`}</div>
  <div class="chart-foot">${icon('info')}余额同步不代表已领取奖励；未知奖励可在日志中查看。</div></section>`;
}
function schedule(){
 const s=state.data.settings,n=nextRun(),enabled=state.data.accounts.filter(a=>a.enabled).length;
 return `<section class="panel schedule-panel"><div class="panel-head"><div><h2 class="panel-title">自动运行</h2><p class="panel-sub">按账号间隔执行签到</p></div><button class="icon-button" data-action="settings" title="定时设置" aria-label="定时设置">${icon('settings')}</button></div>
  <div class="schedule-main"><span class="schedule-status ${s.scheduler_enabled?'':'paused'}"><i></i>${s.scheduler_enabled?'调度已启用':'自动运行已暂停'}</span><div class="schedule-next-label">下一次运行</div><div class="schedule-time">${s.scheduler_enabled&&n?timeLabel(n.next_run):s.scheduler_enabled?'等待添加账号':'暂未安排'}</div><div class="schedule-caption">${s.scheduler_enabled&&n?`${esc(n.name)} · ${providerName(n.provider)}`:'随时可以手动运行签到'}</div>
  <dl class="schedule-detail"><div><dt>自动运行账号</dt><dd>${enabled}<span> / ${state.data.accounts.length}</span></dd></div><div><dt>默认执行间隔</dt><dd>每 ${s.interval_hours} 小时</dd></div><div><dt>运行时区</dt><dd>${esc(state.data.web?.timezone||'本机时间')}</dd></div></dl></div>
  <div class="switch-row"><div><b>后台定时签到</b><span>关闭网页后继续运行</span></div><button class="switch ${s.scheduler_enabled?'on':''}" data-action="toggle-scheduler" aria-label="切换自动签到" aria-pressed="${s.scheduler_enabled}"></button></div></section>`;
}
function statusBadge(status){return `<span class="status-badge ${esc(status)}">${status==='success'||status==='already_checked'?icon('checkplain'):status==='manual_required'||status==='failed'?icon('warning'):''}${labels[status]||esc(status)}</span>`;}
function accountRows(accounts){if(!accounts.length)return `<tr><td colspan="7" class="empty-row"><div class="empty-state"><div class="empty-illustration">${icon('users')}</div><b>${state.query||state.filter!=='all'?'没有匹配的账号':'把常用站点，连接到这里。'}</b><p>${state.query||state.filter!=='all'?'更换关键词或平台筛选，查看其他账号。':'添加你的第一个账号，让签到、余额与运行记录集中呈现。'}</p>${state.query||state.filter!=='all'?'':`<button class="button primary small" data-action="add">${icon('plus')}添加第一个账号</button>`}</div></td></tr>`;return accounts.map(a=>`<tr><td><div class="account-name"><span class="provider-badge ${a.provider==='anyrouter'?'any':a.provider==='agentrouter'?'agent':'custom'}">${esc((allProviders().find(p=>p.id===a.provider)?.name||a.provider).slice(0,1))}</span><div>${esc(a.name)}<small>${providerName(a.provider)}</small></div></div></td><td>${statusBadge(a.status)}</td><td class="balance">${money(a.balance,a.currency)}</td><td class="hide-mobile">${timeLabel(a.last_run)}</td><td class="hide-medium">${a.enabled?timeLabel(a.next_run):'自动运行已关闭'}</td><td class="hide-medium">${authLabel(a)}</td><td><div class="row-actions"><button class="icon-button" data-action="run" data-id="${a.id}" title="立即运行" aria-label="运行 ${esc(a.name)}" ${['running','queued'].includes(a.status)?'disabled':''}>${['running','queued'].includes(a.status)?'<i class="inline-spinner"></i>':icon('play')}</button>${a.auth_mode==='session'?`<button class="icon-button" data-action="relogin" data-id="${a.id}" title="重新填写凭据" aria-label="重新填写 ${esc(a.name)} 的凭据">${icon('refresh')}</button>`:''}${isOAuth(a.login_via)?`<button class="icon-button hide-mobile" data-action="connect-platform" data-id="${a.id}" title="连接其他平台" aria-label="连接其他平台">${icon('plus')}</button>`:''}<button class="icon-button" data-action="edit" data-id="${a.id}" title="编辑账号" aria-label="编辑 ${esc(a.name)}">${icon('dots')}</button></div></td></tr>`).join('');}
function filteredAccounts(){let accounts=state.data.accounts;if(state.filter!=='all')accounts=accounts.filter(a=>a.provider===state.filter);if(state.query)accounts=accounts.filter(a=>a.name.toLowerCase().includes(state.query.toLowerCase()));return accounts;}
function accountsPanel(overview=false){
 const accounts=overview?state.data.accounts:filteredAccounts(),scrollable=overview&&accounts.length>5;
 return `<section class="panel accounts-panel"><div class="panel-head${overview?'':' account-management-head'}"><div><div class="section-heading"><h2 class="panel-title">${overview?'我的账号':'账号列表'}</h2><span class="count">${accounts.length}</span></div><p class="panel-sub">${overview?'各站点的余额与运行状态，一处查看':'凭据独立保存，按账号管理自动运行'}</p></div><div class="accounts-head-actions">${overview?`<button class="panel-link" data-view="accounts">管理账号${icon('chevron')}</button>`:`<button class="button secondary small" data-action="accounts-import">${icon('upload')}导入账号</button><button class="button secondary small" data-action="accounts-export" ${state.data.accounts.length?'':'disabled'}>${icon('download')}导出账号</button>`}</div></div>
  <div class="table-wrap${scrollable?' overview-accounts-scroll':''}"${overview?' id="overview-accounts" tabindex="0" role="region" aria-label="概览账号列表，可滚动查看"':''}><table class="account-table"><thead><tr><th scope="col">账号 / 平台</th><th scope="col">运行状态</th><th scope="col">当前余额</th><th scope="col" class="hide-mobile">上次运行</th><th scope="col" class="hide-medium">下一次运行</th><th scope="col" class="hide-medium">认证方式</th><th scope="col" class="actions-heading">操作</th></tr></thead><tbody>${accountRows(accounts)}</tbody></table></div></section>`;
}
function recentRuns(limit=4){
 const runs=state.data.runs.slice(0,limit);
 return `<section class="panel activity-panel"><div class="panel-head"><div><h2 class="panel-title">最近运行</h2><p class="panel-sub">每一次签到，都有记录</p></div><button class="panel-link" data-view="logs">查看日志${icon('chevron')}</button></div>${runs.length?`<div class="activity-list">${runs.map(r=>`<button class="recent-item" data-action="log" data-id="${r.id}"><span class="activity-icon ${esc(r.status)}">${icon(['success','already_checked','synced'].includes(r.status)?'checkplain':['failed','manual_required'].includes(r.status)?'warning':'clock')}</span><span class="grow"><b>${esc(r.account_name)}</b><small>${providerName(r.provider)} · ${r.trigger==='manual'?'手动运行':'定时运行'}</small></span><span class="activity-reward">${r.reward==null?'奖励未知':r.reward>0?'+'+money(r.reward,r.currency):money(0,r.currency)}</span>${statusBadge(r.status)}<time>${timeLabel(r.started_at,true)}</time>${icon('chevron')}</button>`).join('')}</div>`:`<div class="empty-state compact">${icon('list')}<b>还没有运行记录</b><p>完成首次签到后，可在这里查看结果。</p></div>`}</section>`;
}
function providerDistribution(){
 const counts=new Map();
 for(const account of state.data.accounts)counts.set(account.provider,(counts.get(account.provider)||0)+1);
 const total=state.data.accounts.length,groups=[...counts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
 return `<section class="panel distribution-panel"><div class="panel-head"><div><h2 class="panel-title">账号分布</h2><p class="panel-sub">按站点统计 · ${total} 个账号</p></div><button class="panel-link" data-view="sites">站点${icon('chevron')}</button></div>${total?`<ul class="distribution-list">${groups.map(([id,count],i)=>`<li><div class="distribution-label"><span>${providerName(id)}</span><span>${count} 个 <small>${Math.round(count/total*100)}%</small></span></div><div class="distribution-track" aria-hidden="true"><span class="${i===0?'leading':''}" style="width:${count/total*100}%"></span></div></li>`).join('')}</ul>`:`<div class="empty-state compact">${icon('layers')}<b>站点分布，一目了然</b><p>连接账号后，查看各站点的账号数量。</p></div>`}</section>`;
}
function quickActions(){
 return `<section class="panel quick-panel"><div class="panel-head"><div><h2 class="panel-title">快捷操作</h2><p class="panel-sub">常用管理，一步到达</p></div></div><div class="quick-grid"><button class="quick-button" data-action="add" aria-haspopup="dialog" aria-controls="modal">${icon('plus')}<span>添加账号</span></button><button class="quick-button" data-action="accounts-import" aria-haspopup="dialog" aria-controls="modal">${icon('upload')}<span>导入账号</span></button><button class="quick-button" data-action="accounts-export" aria-haspopup="dialog" aria-controls="modal" ${state.data.accounts.length?'':'disabled'}>${icon('download')}<span>导出账号</span></button><button class="quick-button" data-action="add-site" aria-haspopup="dialog" aria-controls="modal">${icon('layers')}<span>添加站点</span></button><button class="quick-button" data-action="settings" aria-haspopup="dialog" aria-controls="modal">${icon('settings')}<span>定时设置</span></button><button class="quick-button" data-view="logs">${icon('list')}<span>查看日志</span></button></div></section>`;
}
function overview(){return `${currencyPicker()}<div class="overview-board">${stats()}${chart()}${schedule()}${recentRuns(5)}${accountsPanel(true)}${providerDistribution()}${quickActions()}</div>`;}
function accountsView(){return `<div class="toolbar accounts-toolbar"><div class="filter-group" aria-label="按站点筛选账号">${[['all','全部账号'],...providers().map(p=>[p.id,p.name]),...Array.from(new Set(state.data.accounts.map(a=>a.provider))).filter(id=>!providers().some(p=>p.id===id)).map(id=>[id,id])].map(([value,label])=>`<button class="filter ${state.filter===value?'active':''}" data-filter="${esc(value)}" aria-pressed="${state.filter===value}">${esc(label)}<span>${state.data.accounts.filter(a=>value==='all'||a.provider===value).length}</span></button>`).join('')}</div><div class="search">${icon('search')}<input id="account-search" value="${esc(state.query)}" placeholder="搜索账号名称" aria-label="搜索账号" autocomplete="off"></div></div>${accountsPanel()}`;}
function logsView(){
 const all=state.data.runs,runs=all.filter(r=>state.logFilter==='all'||r.status===state.logFilter);
 return `<div class="toolbar"><span class="panel-sub">最近 ${all.length} 条运行记录</span><div class="filter-group" aria-label="按结果筛选日志">${[['all','全部'],['success','签到成功'],['synced','余额同步'],['manual_required','需要处理'],['failed','失败']].map(([value,label])=>`<button class="filter ${state.logFilter===value?'active':''}" data-log-filter="${value}" aria-pressed="${state.logFilter===value}">${label}</button>`).join('')}</div></div>
 <section class="panel logs-panel"><div class="panel-head"><div><h2 class="panel-title">运行记录</h2><p class="panel-sub">签到与余额同步分别记录</p></div><button class="button secondary small" data-action="export">${icon('download')}导出 CSV</button></div><div class="table-wrap"><table class="account-table"><thead><tr><th scope="col">运行时间</th><th scope="col">账号 / 平台</th><th scope="col" class="hide-mobile">触发方式</th><th scope="col">结果</th><th scope="col">新增额度</th><th scope="col" class="hide-medium">站点说明</th><th scope="col"><span class="sr-only">详情</span></th></tr></thead><tbody>${runs.length?runs.map(r=>`<tr><td>${timeLabel(r.started_at,true)}</td><td><div class="account-name"><span>${esc(r.account_name)}<small>${providerName(r.provider)}</small></span></div></td><td class="hide-mobile">${r.trigger==='manual'?'手动':'定时'}</td><td>${statusBadge(r.status)}</td><td class="balance ${r.reward>0?'success-text':''}">${r.reward==null?'<span class="unknown-money">奖励未知</span>':(r.reward>0?'+':'')+money(r.reward,r.currency)}</td><td class="log-message hide-medium">${esc(r.message)}</td><td><button class="icon-button" data-action="log" data-id="${r.id}" aria-label="查看 ${esc(r.account_name)} 运行详情">${icon('chevron')}</button></td></tr>`).join(''):`<tr><td colspan="7" class="empty-row"><div class="empty-state"><div class="empty-illustration">${icon('list')}</div><b>${state.logFilter==='all'?'等待第一次运行':'没有对应的运行记录'}</b><p>每次运行都会记录结果，金额未知时也会明确标记。</p></div></td></tr>`}</tbody></table></div></section>`;
}
function render(){
 if(!state.data)return;
 const searchFocused=document.activeElement?.id==='account-search',searchPosition=searchFocused?document.activeElement.selectionStart:null;
 const scroller=$('#overview-accounts'),saved=scroller?{top:scroller.scrollTop,left:scroller.scrollLeft,focused:document.activeElement===scroller}:null;
 const views={overview:['概览','签到概览','你的站点额度、今日进度与下一次运行。'],accounts:['账号','账号管理','集中管理站点凭据、余额与自动运行。'],sites:['站点','站点管理','连接 AnyRouter、AgentRouter 和你常用的兼容站点。'],logs:['运行日志','运行日志','查看签到结果、额度变化与需要处理的任务。']};
 const title=views[state.view]||views.overview;
 $('#crumb').textContent=title[0];$('#page-title').textContent=title[1];$('#page-description').textContent=title[2];$('#nav-count').textContent=state.data.accounts.length;
 $$('.nav-item').forEach(el=>{const current=el.dataset.view===state.view;el.classList.toggle('active',current);if(current)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');});
 $('#app-version').textContent=state.data.engine?.version?`v${String(state.data.engine.version).replace(/^v/,'')}`:'网页控制台';
 $('#admin-button').hidden=!state.data.web?.enabled;
 if(state.auth?.username){$('#user-name').textContent=state.auth.username;$('#user-avatar').textContent=state.auth.username.slice(0,1).toUpperCase();}
 $('#app').innerHTML=state.view==='overview'?overview():state.view==='accounts'?accountsView():state.view==='sites'?sitesView():logsView();
 const current=$('#overview-accounts');
 if(current&&saved){current.scrollTop=saved.top;current.scrollLeft=saved.left;if(saved.focused)current.focus({preventScroll:true});}
 if(searchFocused){const search=$('#account-search');if(search){search.focus({preventScroll:true});search.setSelectionRange(searchPosition,searchPosition);}}
}
function modal(content,{destructive=false}={}){
 disposeAccountTransfer();
 const dialog=$('#modal');
 if(!dialog.open)modalTrigger=document.activeElement;
 $('#modal-content').innerHTML=content;
 const heading=$('#modal-content h2');if(heading)heading.id='dialog-title';
 const description=$('#modal-content .modal-head p');
 if(description){description.id=description.id||'dialog-description';dialog.setAttribute('aria-describedby',description.id);}else dialog.removeAttribute('aria-describedby');
 if(destructive)dialog.setAttribute('role','alertdialog');else dialog.removeAttribute('role');
 if(destructive){const error=document.createElement('div');error.className='form-errors-summary';error.setAttribute('role','alert');error.hidden=true;$('.modal-actions',dialog)?.before(error);}
 dialog.classList.toggle('account-dialog',!!$('#account-form'));
 for(const label of $$('.field>label',$('#modal-content'))){const input=label.parentElement.querySelector('input,select');if(input){input.id=input.id||`field-${input.name}`;label.htmlFor=input.id;}}
 if(!dialog.open)dialog.showModal();
 if(destructive)$('[data-action="close"]',dialog)?.focus({preventScroll:true});
}
function stopLoginPoll(){clearTimeout(loginPoll);loginPoll=null;}
function closeModal(){
  disposeAccountTransfer();
  if(typeof cancelSiteProbe==='function')cancelSiteProbe($('#provider-form'));
  stopLoginPoll();
  const queue=state.loginQueue;
  if(queue){
    queue.stopped=true;
    queue.connection=null;
    if(queue.session)void cancelLoginSession(queue,queue.session);
  }
  clearBrowserImportFields();
  const accountForm=$('#account-form');if(accountForm){accountForm.reset();credentialRequests.delete(accountForm);}
  state.loginSession=null;
  $('#modal').close();
  if(modalTrigger?.isConnected)modalTrigger.focus({preventScroll:true});
  modalTrigger=null;
  state.editing=null;
  state.connecting=null;
  state.targetProvider=null;
}
function methodName(method){return {github:'GitHub',linuxdo:'LinuxDO',manual:'手动填写',password:'账号密码',session:'Session'}[method]||method;}
function accountMethod(account){return account.auth_mode==='password'?'password':'session';}
function eligibleProviders(){return providers().filter(p=>(!state.targetProvider||p.id===state.targetProvider)&&(p.login_methods||[]).includes(state.loginMethod)&&p.id!==state.connecting?.provider);}
function accountModal(account=null,connecting=null,targetProvider=null){
  if(state.loginQueue&&!state.loginQueue.stopped&&!state.loginQueue.done)return;
  state.loginQueue=null;
  state.editing=account;
  state.connecting=connecting;
  state.targetProvider=targetProvider;
  state.reauth=false;
  state.loginMethod=account?accountMethod(account):'session';
  state.selectedProviders=targetProvider?[targetProvider]:[];
  modal(`<div class="modal-head"><div><h2>${account?'编辑账号':connecting?'连接其他平台':'添加账号'}</h2><p>${account?'凭据已加密保存，留空保留；替换时请填写同一站点账号。':connecting?`为新平台填写自己的凭据，不复制「${esc(connecting.name)}」的 Cookie。`:'选择站点，直接填写自己的账号凭据。'}</p></div><button class="icon-button" data-action="close" aria-label="关闭">${icon('x')}</button></div>
  <form id="account-form" novalidate>
    <div class="account-form-body">
    <div class="form-errors-summary" role="alert" hidden></div>
    <div class="form-grid account-basics"><div class="field"><label>账号备注</label><input name="name" required maxlength="40" value="${esc((account||connecting)?.name||'')}" placeholder="例如：我的主账号"></div><div id="platform-picker"></div></div>
    <div class="field credential-mode-picker"><span class="field-label" id="credential-mode-label">凭据方式</span><div class="segmented" role="group" aria-labelledby="credential-mode-label"><button type="button" data-method="session">Session Cookie</button><button type="button" data-method="password">账号密码</button></div></div>
    <div id="credentials"></div>
    ${account?`<div class="settings-line account-auto-setting"><div><b>此账号自动运行</b><p>暂停后仍可手动签到，已保存的凭据会保留。</p></div><button type="button" class="switch ${account.enabled?'on':''}" data-action="toggle-account-enabled" data-id="${account.id}" aria-label="切换此账号自动运行" aria-pressed="${account.enabled}"></button></div>`:''}
    ${account?`<div class="account-tools"><button type="button" class="button secondary small" data-action="run" data-id="${account.id}">${icon('play')}立即运行</button></div>`:''}
    <details id="account-advanced" class="account-advanced"><summary>执行间隔与网络代理 <span>默认每 ${((account||connecting)?.interval_hours||6)} 小时</span></summary><div class="account-advanced-content"><div class="field"><label for="account-interval">执行间隔</label><select id="account-interval" name="interval_hours">${Array.from(new Set([1,3,6,12,24,((account||connecting)?.interval_hours||6)])).sort((a,b)=>a-b).map(h=>`<option value="${h}" ${((account||connecting)?.interval_hours||6)===h?'selected':''}>每 ${h} 小时</option>`).join('')}</select></div>${proxyFields(account?.proxy)}</div></details>
    <div class="credential-security-note">${icon('shield')}凭据加密保存在你部署的服务器。Session 将先核对原站身份。</div>
    </div>
    <div class="modal-actions">${account?`<button type="button" class="button ghost danger push-left" data-action="delete" data-id="${account.id}">删除账号</button>`:''}<button type="button" class="button secondary" data-action="close">取消</button><button class="button primary" type="submit" id="account-submit"></button></div>
  </form>`);
  syncMethod();
  syncProxy();
}
function proxyFields(proxy={mode:'default'}){
  return `<section class="proxy-settings" aria-label="账号网络代理">
    <div class="field"><label for="proxy-mode">网络代理 <span class="field-optional">仅用于此账号</span></label>
      <select id="proxy-mode" name="proxy_mode"><option value="default" ${proxy.mode==='default'?'selected':''}>默认网络</option><option value="direct" ${proxy.mode==='direct'?'selected':''}>直连 · 不使用代理</option><option value="custom" ${proxy.mode==='custom'?'selected':''}>自定义代理</option></select>
      <p id="proxy-hint" class="field-help"></p></div>
    <div id="proxy-custom" hidden>
      <div class="field"><label for="proxy-server">代理地址</label><input id="proxy-server" name="proxy_server" maxlength="2048" value="${esc(proxy.server||'')}" placeholder="http://proxy.example:7890" autocomplete="off" spellcheck="false"><small>支持 HTTP、HTTPS、SOCKS5，请填写协议、主机与端口。</small></div>
      <label class="proxy-auth-toggle"><input type="checkbox" name="proxy_auth" ${proxy.has_auth?'checked':''}>代理需要用户名和密码</label>
      <div id="proxy-auth-fields" class="form-grid" hidden>
        <div class="field"><label for="proxy-username">代理用户名</label><input id="proxy-username" name="proxy_username" maxlength="300" autocomplete="off"></div>
        <div class="field"><label for="proxy-password">代理密码</label><input id="proxy-password" name="proxy_password" type="password" maxlength="1000" autocomplete="new-password"></div>
      </div>
      <p class="field-help">此代理用于服务器的凭据校验、账号密码登录、余额查询与签到。切换网络出口后，网站可能要求重新登录。SOCKS5 仅支持无认证连接。</p>
    </div>
  </section>`;
}
function syncProxy(){
  const mode=$('[name="proxy_mode"]');if(!mode)return;
  const custom=mode.value==='custom',server=$('[name="proxy_server"]'),auth=$('[name="proxy_auth"]');
  $('#proxy-custom').hidden=!custom;server.disabled=!custom;server.required=custom;auth.disabled=!custom;
  const authenticated=custom&&auth.checked;
  $('#proxy-auth-fields').hidden=!authenticated;
  const saved=state.editing?.proxy;
  const keep=!!saved?.has_auth&&server.value.trim().replace(/\/$/,'')===saved.server;
  for(const key of ['username','password']){
    const input=$(`[name="proxy_${key}"]`);input.disabled=!authenticated;input.required=authenticated&&!keep;
    input.placeholder=keep?'已加密保存，留空保留':key==='username'?'填写代理用户名':'填写代理密码';
  }
  $('#proxy-hint').textContent=custom?'认证信息仅在服务端加密保存。':mode.value==='direct'?'此账号的后台校验、登录与签到直接连接网站。':'沿用平台原有网络设置；未配置环境代理时直接连接。';
}
function proxyPayload(form){
  const data=Object.fromEntries(new FormData(form));
  if(data.proxy_mode!=='custom')return {mode:data.proxy_mode||'default'};
  const proxy={mode:'custom',server:(data.proxy_server||'').trim(),authenticate:!!data.proxy_auth};
  if(proxy.authenticate){
    if(data.proxy_username)proxy.username=data.proxy_username;
    if(data.proxy_password)proxy.password=data.proxy_password;
  }
  return proxy;
}
function platformPicker(){
  const target=$('#platform-picker');if(!target)return;
  const eligible=eligibleProviders();
  if(state.editing||state.targetProvider){
    const targetId=state.editing?.provider||state.targetProvider;
    state.selectedProviders=[targetId];
    target.innerHTML=`<div class="field"><label for="account-provider">所属站点（已固定）</label><select id="account-provider" name="provider" disabled><option value="${esc(targetId)}">${providerName(targetId)}</option></select></div>`;
  }else{
    const valid=state.selectedProviders.filter(id=>eligible.some(p=>p.id===id));
    state.selectedProviders=valid.length?valid:[eligible.find(p=>p.id==='anyrouter')?.id||eligible[0]?.id].filter(Boolean);
    if(!isOAuth(state.loginMethod))state.selectedProviders=state.selectedProviders.slice(0,1);
    target.innerHTML=`<div class="field"><label for="account-provider">所属站点</label><select id="account-provider" name="provider">${eligible.map(p=>`<option value="${esc(p.id)}" ${state.selectedProviders.includes(p.id)?'selected':''}>${esc(p.name)}</option>`).join('')}</select>${eligible.length?'':'<p class="field-help">当前没有支持此凭据方式的站点。</p>'}</div>`;
  }
  updateAccountSubmit();
  if($('#account-form')?.dataset.validationAttempted)validateAccountForm($('#account-form'),false);
}
function updateAccountSubmit(){
  syncCredentialLabels();
  const submit=$('#account-submit');if(!submit)return;
  submit.disabled=state.busy||(!state.editing&&!eligibleProviders().length);
   submit.textContent=state.busy?'正在保存…':state.editing?'保存修改':state.loginMethod==='session'?'校验并保存':'保存账号';
}
function syncMethod(){
  $$('[data-method]').forEach(b=>{
    b.classList.toggle('active',b.dataset.method===state.loginMethod);
    b.setAttribute('aria-pressed',String(b.dataset.method===state.loginMethod));
    const candidates=providers().filter(p=>state.editing?p.id===state.editing.provider:state.targetProvider?p.id===state.targetProvider:p.id!==state.connecting?.provider);
    b.disabled=!candidates.some(p=>(p.login_methods||[]).includes(b.dataset.method));
  });
  platformPicker();
  credentialFields(state.loginMethod,!!state.editing&&!state.reauth);
  syncCredentialLabels();
  for(const label of $$('#credentials .field>label')){const input=label.parentElement.querySelector('input');if(input){input.id=`credential-${input.name}`;label.htmlFor=input.id;}}
  if($('#account-form')?.dataset.validationAttempted)validateAccountForm($('#account-form'),false);
}
function credentialFields(method,editing=false){
  const f=$('#credentials');if(!f)return;
  if(isBrowser(method)){
    f.innerHTML='';
    return;
  }
  const preserve=editing&&accountMethod(state.editing)===method;
  if(method==='password'){
    f.innerHTML=`<div class="form-grid credential-inputs"><div class="field"><label id="credential-login-label">用户名或邮箱</label><input name="email" type="text" maxlength="200" placeholder="${preserve?'留空则保留已保存的账号':'本站用户名或邮箱'}" ${preserve?'':'required'} autocomplete="username"></div><div class="field"><label>登录密码</label><input name="password" type="password" maxlength="300" placeholder="${preserve?'留空则保留已保存的密码':'本站登录密码'}" ${preserve?'':'required'} autocomplete="new-password"></div></div><p id="credential-provider-hint" class="credential-provider-hint"></p>`;
    return;
  }
  f.innerHTML=`<div class="form-grid credential-inputs"><div class="field"><label id="credential-session-label">Session Cookie</label><input name="session" type="password" maxlength="32000" placeholder="${preserve?'留空则保留已保存的 Session':'本站 session Cookie 原值'}" ${preserve?'':'required'} autocomplete="off"></div><div class="field"><label id="credential-user-label">站内用户 ID</label><input name="api_user" ${preserve?'':'required'} maxlength="100" inputmode="numeric" pattern="[1-9][0-9]*" placeholder="${preserve?'留空则保留已保存的 ID':'本站 user 中的 id'}" autocomplete="off"></div></div><p id="credential-provider-hint" class="credential-provider-hint"></p><details class="credential-help" id="credential-help"><summary id="credential-help-summary">如何获取 Session 和用户 ID</summary><p id="credential-help-instructions"></p><a id="credential-site-link" class="panel-link" target="_blank" rel="noopener noreferrer">打开站点登录页 ${icon('link')}</a></details>`;
}
function syncCredentialLabels(){
  if(!$('#account-form'))return;
  const provider=providers().find(p=>p.id===(state.editing?.provider||state.selectedProviders[0]));
  const sub2api=provider?.template?.startsWith('sub2api');
  const login=$('[name="email"]');
  if(login){
    login.type=sub2api?'email':'text';
    if(!state.editing)login.placeholder=sub2api?'name@example.com':'本站用户名或邮箱';
    const label=$('#credential-login-label');
    if(label)label.textContent=sub2api?'登录邮箱':'用户名或邮箱';
  }
  const method=$('[data-method="session"]');if(method)method.textContent=sub2api?'登录 Token':'Session Cookie';
  const userLabel=$('#credential-user-label');if(userLabel)userLabel.textContent='站内用户 ID';
  const user=$('[name="api_user"]');if(user&&!state.editing)user.placeholder='本站 user 中的 id';
  const label=$('#credential-session-label');
  if(label)label.textContent=sub2api?'登录 Token（不是 API Key）':'Session Cookie';
  const session=$('[name="session"]');
  if(session&&!state.editing)session.placeholder=sub2api?'本站 Local Storage 中 auth_token 的值':'本站 session Cookie 原值';
  const hint=$('#credential-provider-hint');
  if(hint)hint.textContent=state.loginMethod==='password'?(provider?.id==='agentrouter'?'填写 AgentRouter 站内用户名或邮箱与密码。仅用 GitHub / LinuxDO 登录且未设置本站密码时，请选择 Session。后台运行使用服务器网络，登录和奖励以本站响应为准。':'填写本站账号与密码，后台运行时使用服务器网络登录；验证码或防护无法通过时，请改用 Session。'):provider?.id==='agentrouter'?'AgentRouter：Session 和用户 ID 可同步余额，不代表已领取登录奖励。':'填写同一站点的有效凭据，后台只读校验身份与余额后才保存。';
  const instructions=$('#credential-help-instructions');
  if(instructions)instructions.textContent=sub2api?'先在本站登录。在开发者工具 Application → Local Storage 复制 auth_token，在 user 中查看 id。请填写登录 Token，不是模型 API Key。':'先在本站登录。在开发者工具 Application → Cookies 复制 session 的原值，在 Local Storage → user 中查看 id。只填字段值，不粘贴整段 Cookie 请求头。';
  const summary=$('#credential-help-summary');if(summary)summary.textContent=sub2api?'如何获取登录 Token 和用户 ID':'如何获取 Session 和用户 ID';
  const link=$('#credential-site-link');if(link)link.href=userSiteUrl(provider?.id)||'#';
}
function settingsModal(){const s=state.data.settings;modal(`<div class="modal-head"><div><h2>定时设置</h2><p>任务由后台执行，关闭网页不影响自动运行。</p></div><button class="icon-button" data-action="close" aria-label="关闭">${icon('x')}</button></div><form id="settings-form"><div class="settings-line"><div><b>启用自动签到</b><p>仅为已启用的账号安排定时任务</p></div><button type="button" class="switch ${s.scheduler_enabled?'on':''}" data-action="modal-switch" aria-label="启用自动签到" aria-pressed="${s.scheduler_enabled}"></button></div><div class="settings-line"><div><label for="settings-interval"><b>统一执行间隔</b></label><p>保存后将应用到所有账号</p></div><select id="settings-interval" name="interval_hours">${Array.from(new Set([1,3,6,12,24,s.interval_hours])).sort((a,b)=>a-b).map(h=>`<option value="${h}" ${s.interval_hours===h?'selected':''}>每 ${h} 小时</option>`).join('')}</select></div><input type="hidden" name="scheduler_enabled" value="${s.scheduler_enabled}"><div class="notice">${icon('info')}服务保持运行时，按账号间隔执行。网站未发放奖励时，会记录实际签到或余额同步结果。</div><div class="modal-actions"><button type="button" class="button secondary" data-action="close">取消</button><button class="button primary" type="submit">保存设置</button></div></form>`);}
function validateAccountForm(form,focus=true){
  form.dataset.validationAttempted='true';
  $$('.field-error',form).forEach(el=>el.remove());
  $$('.field-invalid',form).forEach(el=>el.classList.remove('field-invalid'));
  $$('[aria-invalid]',form).forEach(el=>{el.removeAttribute('aria-invalid');el.removeAttribute('aria-describedby');});
  const names={name:'账号备注',email:'用户名或邮箱',password:'登录密码',session:'登录凭据',api_user:'站内用户 ID',
    proxy_server:'代理地址',proxy_username:'代理用户名',proxy_password:'代理密码'};
  const errors=[];
  for(const input of $$('input,select',form)){
    if(!input.willValidate||input.type==='checkbox'||input.type==='hidden')continue;
    const label=names[input.name]||'此项';
    if(input.required&&!input.value.trim())errors.push([input,`请填写${label}`]);
    else if(input.validity.typeMismatch)errors.push([input,`请输入有效的${label}`]);
    else if(!input.validity.valid)errors.push([input,`请检查${label}的格式或范围`]);
  }
  const mode=$('[name="proxy_mode"]',form),server=$('[name="proxy_server"]',form);
  if(mode?.value==='custom'&&server.value.trim()){
    const address=server.value.trim();
    const match=address.match(/^(https?|socks5):\/\/(?:\[[0-9a-f:]+\]|[^/?#:@\\\s]+):(\d+)\/?$/i);
    if(!match||Number(match[2])<1||Number(match[2])>65535){
      if(!errors.some(([input])=>input===server))errors.push([server,'请填写有效代理地址，如 http://127.0.0.1:7890；认证信息请单独填写']);
    }else if(match[1].toLowerCase()==='socks5'&&$('[name="proxy_auth"]',form).checked){
      errors.push([$('[name="proxy_auth"]',form),'SOCKS5 仅支持无认证；需要用户名密码时请选择 HTTP/HTTPS 代理']);
    }
  }
  if(!state.selectedProviders.length){
    const target=$('[name="providers"],[name="provider"]',form)||$('#platform-picker');
    errors.push([target,'请至少选择一个授权平台']);
  }
  errors.sort((a,b)=>a[0]===b[0]?0:(a[0].compareDocumentPosition(b[0])&Node.DOCUMENT_POSITION_FOLLOWING?-1:1));
  for(const [input,message] of errors){
    const parent=input.closest('.proxy-auth-toggle')||input.closest('.field')||input;
    parent.classList.add('field-invalid');
    const id=`field-error-${input.name||'platform'}`;
    const help=document.createElement('p');help.className='field-error';help.id=id;help.textContent=message;
    parent.appendChild(help);input.setAttribute('aria-invalid','true');input.setAttribute('aria-describedby',id);
  }
  const summary=$('.form-errors-summary',form);
  summary.hidden=!errors.length;summary.textContent=errors.length?`请完善标红的 ${errors.length} 项信息后继续。`:'';
  if(focus&&errors.length){
    const first=errors[0][0];for(let details=first.closest('details');details;details=details.parentElement.closest('details'))details.open=true;first.scrollIntoView({block:'center',behavior:'instant'});first.focus({preventScroll:true});
  }
  return !errors.length;
}
async function saveAccount(form){
  if(state.busy)return;
  state.busy=true;
  try{
    if(!validateAccountForm(form))return;
    const data=Object.fromEntries(new FormData(form));
    const method=state.loginMethod,editing=state.editing;
    const name=(data.name||'').trim();
    if(!name)throw new Error('请先填写账号备注');
    const selected=editing?[editing.provider]:state.selectedProviders;
    if(!selected.length)throw new Error('请至少选择一个平台');
    if(isBrowser(method)&&(!editing||state.reauth)){
      return launchLogin({method,interval_hours:Number(data.interval_hours),name,account_id:editing?.id||null,proxy:proxyPayload(form)},selected);
    }
    const mode=method==='password'?'password':'session';
    if(mode==='session'&&(!editing||data.session||data.api_user||state.reauth)){
      const session=(data.session||'').trim(),api_user=(data.api_user||'').trim();
      if(!session||!(/^[1-9][0-9]*$/).test(api_user))throw new Error('请同时填写本站 Session / 登录 Token 和有效的数字用户 ID。');
      const payload={name,provider:editing?.provider||selected[0],session,api_user,interval_hours:Number(data.interval_hours),proxy:proxyPayload(form),account_id:editing?.id||null};
      const fingerprint=JSON.stringify(payload),last=credentialRequests.get(form);
      const requestId=last?.fingerprint===fingerprint?last.id:Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,'0')).join('');
      credentialRequests.set(form,{fingerprint,id:requestId});
      let result;
      try{result=await api('/api/accounts/import',{method:'POST',body:{...payload,request_id:requestId}});}
      catch(error){if(error.status===410||error.status===409&&/管理员或站点设置已变化|先前保存的账号已移除|本次保存已取消|此保存请求已用于其他内容/.test(error.message))credentialRequests.delete(form);throw error;}
      if(result.status!=='success')throw new Error(result.message||'账号尚未保存，请查看当前连接状态。');
      credentialRequests.delete(form);
      if(form.isConnected){form.reset();closeModal();}
      toast(result.message||'本站身份和余额已校验，账号已保存');await refresh(true);return;
    }
    const body={name,provider:editing?.provider||selected[0],auth_mode:mode,interval_hours:Number(data.interval_hours),enabled:editing?editing.enabled:true};
    body.proxy=proxyPayload(form);
    if(!isBrowser(method))body.login_via=method;
    for(const k of ['password','session','api_user','email'])if(data[k])body[k]=data[k];
    await api(editing?`/api/accounts/${editing.id}`:'/api/accounts',{method:editing?'PUT':'POST',body});
    if(form.isConnected){form.reset();closeModal();}toast(editing?'账号设置已更新':'账号已保存，首次运行时会验证登录并查询余额');await refresh(true);
  }finally{state.busy=false;updateAccountSubmit();}
}
function accountTransferActive(transfer){return !!transfer&&accountFileTransfer===transfer&&!transfer.closed&&transfer.form?.isConnected&&$('#modal').open&&state.auth?.authenticated!==false;}
function disposeAccountTransfer(){
  $('#modal').classList.remove('account-transfer-dialog');
  const transfer=accountFileTransfer;
  if(!transfer)return;
  transfer.closed=true;transfer.generation++;transfer.controller?.abort();
  transfer.form?.reset();transfer.file=null;transfer.preview=null;transfer.previewInput=null;transfer.request=null;transfer.controller=null;
  accountFileTransfer=null;
}
function createAccountTransfer(kind,content){
  modal(`<div class="transfer-shell">${content}</div>`);
  $('#modal').classList.add('account-transfer-dialog');
  const transfer={kind,form:$(`#account-${kind}-form`),closed:false,busy:false,reading:false,generation:0,controller:null,file:null,preview:null,previewInput:null,request:null,encrypted:true};
  accountFileTransfer=transfer;
  return transfer;
}
function backupDate(){try{return new Intl.DateTimeFormat('sv-SE',{timeZone:state.data?.web?.timezone||'Asia/Shanghai'}).format(new Date());}catch{return new Date().toISOString().slice(0,10);}}
function downloadAccountJson(data,filename,pretty=false){
  const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,pretty?2:undefined)],{type:'application/json;charset=utf-8'}));
  const anchor=document.createElement('a');anchor.href=url;anchor.download=filename;document.body.appendChild(anchor);
  try{anchor.click();}finally{anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
}
function transferError(transfer,message){
  if(!accountTransferActive(transfer))return;
  const summary=$('.form-errors-summary',transfer.form);summary.hidden=!message;summary.textContent=message||'';
}
function transferFieldError(transfer,id,message){
  transferError(transfer,message);
  const input=$(`#${id}`,transfer.form);input?.setAttribute('aria-invalid','true');input?.focus();
}
function clearTransferErrors(transfer){
  if(!accountTransferActive(transfer))return;
  transferError(transfer,'');
  for(const input of $$('[aria-invalid]',transfer.form))input.removeAttribute('aria-invalid');
}
function syncAccountTransfer(transfer){
  if(!accountTransferActive(transfer))return;
  const locked=transfer.busy||transfer.reading;
  transfer.form.setAttribute('aria-busy',String(locked));
  for(const input of $$('input,select,[data-export-format]',transfer.form))input.disabled=locked;
  if(transfer.kind==='export'){
    const scope=$('#account-export-scope'),count=scope.value==='filtered'?filteredAccounts().length:state.data.accounts.length;
    scope.querySelector('[value="filtered"]').disabled=filteredAccounts().length===0;
    $('#account-export-count').textContent=`将导出 ${count} 个账号，包含所需的站点配置。`;
    $('#account-export-passwords').hidden=!transfer.encrypted;
    for(const input of $$('#account-export-passwords input')){input.disabled=locked||!transfer.encrypted;input.required=transfer.encrypted;}
    for(const button of $$('[data-export-format]')){const selected=(button.dataset.exportFormat==='encrypted')===transfer.encrypted;button.classList.toggle('active',selected);button.setAttribute('aria-pressed',String(selected));}
    const button=$('#account-export-submit');button.disabled=locked||!count;button.textContent=transfer.busy?'正在生成…':'下载账号备份';
    $('#account-export-note').textContent=transfer.encrypted?'导入时需要此密码。备份含账号登录凭据、网络代理与站点配置。':'普通 JSON 会直接包含账号密码、Session 等登录凭据，请妥善保管。';
  }else{
    $('#account-import-password-field').hidden=!transfer.file||!transfer.encrypted;
    const password=$('#account-import-password');password.disabled=locked||!transfer.encrypted||!transfer.file;password.required=!!transfer.file&&transfer.encrypted;
    $('#account-import-options').hidden=!transfer.file;
    const preview=$('#account-import-preview-submit'),apply=$('#account-import-submit');
    preview.disabled=locked||!transfer.file;preview.textContent=transfer.busy&&transfer.operation==='preview'?'正在检查…':transfer.preview?'重新预览':'预览导入';
    preview.classList.toggle('primary',!transfer.preview);preview.classList.toggle('secondary',!!transfer.preview);
    apply.hidden=!transfer.preview;apply.disabled=locked||!transfer.preview?.can_import||transfer.preview.error_count>0||!transfer.preview.new_count;
    apply.textContent=transfer.busy&&transfer.operation==='import'?'正在导入…':transfer.preview?.new_count?`导入 ${transfer.preview.new_count} 个账号`:'无需重复导入';
    $('#account-import-template').disabled=locked;
  }
}
function accountExportModal(){
  if(!state.data?.accounts.length)return toast('请先添加账号再导出。');
  const transfer=createAccountTransfer('export',`<div class="modal-head transfer-head"><div><h2>导出账号</h2><p>把账号与站点配置保存到一个文件，便于备份或迁移。</p></div><button class="icon-button" data-action="close" aria-label="关闭">${icon('x')}</button></div>
    <form id="account-export-form" class="transfer-form" novalidate><div class="transfer-body"><div class="form-errors-summary" role="alert" hidden></div>
    <div class="field"><label for="account-export-scope">导出范围</label><select id="account-export-scope" name="scope"><option value="all">全部账号</option><option value="filtered">当前筛选结果</option></select><p id="account-export-count" class="field-help"></p></div>
    <div class="field"><span id="account-export-format-label" class="field-label">文件格式</span><div class="segmented transfer-format" role="group" aria-labelledby="account-export-format-label"><button type="button" data-export-format="encrypted" aria-pressed="true">加密 JSON <span>推荐</span></button><button type="button" data-export-format="plain" aria-pressed="false">普通 JSON</button></div></div>
    <div id="account-export-passwords" class="form-grid"><div class="field"><label for="account-export-password">备份密码</label><input id="account-export-password" name="password" type="password" required minlength="8" maxlength="1024" autocomplete="new-password" placeholder="至少 8 个字符"></div><div class="field"><label for="account-export-confirm">确认备份密码</label><input id="account-export-confirm" name="confirm_password" type="password" required minlength="8" maxlength="1024" autocomplete="new-password" placeholder="再次输入备份密码"></div></div>
    <p id="account-export-note" class="transfer-note"></p></div><div class="modal-actions transfer-actions"><button type="button" class="button secondary" data-action="close">取消</button><button id="account-export-submit" class="button primary" type="submit">下载账号备份</button></div></form>`);
  syncAccountTransfer(transfer);
}
async function exportAccountFile(form){
  const transfer=accountFileTransfer;
  if(!accountTransferActive(transfer)||transfer.form!==form||transfer.kind!=='export'||transfer.busy)return;
  clearTransferErrors(transfer);
  const data=Object.fromEntries(new FormData(form)),password=data.password||'';
  if(transfer.encrypted&&(password.length<8||password.length>1024))return transferFieldError(transfer,'account-export-password','备份密码需要 8 至 1024 个字符。');
  if(transfer.encrypted&&password!==data.confirm_password)return transferFieldError(transfer,'account-export-confirm','两次输入的备份密码不一致。');
  const selected=data.scope==='filtered'?filteredAccounts().map(account=>account.id):null;
  if(selected&&!selected.length)return transferError(transfer,'当前筛选没有账号，请选择全部账号。');
  const encrypted=transfer.encrypted,revision=transfer.generation;
  transfer.busy=true;transfer.operation='export';transfer.controller=new AbortController();syncAccountTransfer(transfer);
  try{
    const result=await api('/api/accounts/export',{method:'POST',body:{encrypted,...(selected?{account_ids:selected}:{}),...(encrypted?{password}:{})},signal:transfer.controller.signal});
    if(!accountTransferActive(transfer)||transfer.generation!==revision)return;
    downloadAccountJson(result,`checkin-assistant-accounts-${backupDate()}${encrypted?'.encrypted':''}.json`);
    closeModal();toast(encrypted?'加密账号备份已生成，请保留备份密码。':'账号 JSON 已导出。');
  }catch(error){if(accountTransferActive(transfer)&&transfer.generation===revision&&error.name!=='AbortError')transferError(transfer,error.message||'备份未能生成，请重试。');}
  finally{if(accountTransferActive(transfer)&&transfer.generation===revision){transfer.busy=false;transfer.controller=null;syncAccountTransfer(transfer);}}
}
function accountImportModal(){
  const transfer=createAccountTransfer('import',`<div class="modal-head transfer-head"><div><h2>导入账号</h2><p>选择账号备份，检查内容后批量添加。</p></div><button class="icon-button" data-action="close" aria-label="关闭">${icon('x')}</button></div>
    <form id="account-import-form" class="transfer-form" novalidate><div class="transfer-body"><div class="form-errors-summary" role="alert" hidden></div>
    <div class="field"><label for="account-import-file">账号备份文件</label><div class="transfer-file-picker"><input id="account-import-file" name="backup_file" type="file" accept=".json,application/json" aria-describedby="account-import-file-help"><div class="transfer-file-label" aria-hidden="true">${icon('upload')}<div><b id="account-import-filename">点击选择 JSON 文件</b><span id="account-import-file-detail">支持普通 JSON 与密码加密备份</span></div><span class="transfer-file-choose">选择文件</span></div></div><div id="account-import-file-help" class="transfer-file-help"><span>最多 500 个账号 · 文件最大 8 MiB</span><button type="button" id="account-import-template" class="panel-link" data-action="accounts-template">下载示例 ${icon('download')}</button></div></div>
    <div id="account-import-password-field" class="field" hidden><label for="account-import-password">备份密码</label><input id="account-import-password" name="password" type="password" minlength="8" maxlength="1024" autocomplete="off" placeholder="导出文件时设置的密码" disabled></div>
    <p id="account-import-file-note" class="transfer-note" role="status">预览会检查文件格式和重复账号，不会执行登录或签到。</p>
    <section id="account-import-preview" class="transfer-preview" aria-label="账号导入预览" hidden></section>
    <div id="account-import-options" hidden><label class="transfer-option"><input id="account-import-restore" name="restore_enabled" type="checkbox"><span>恢复文件中的自动运行设置</span></label><p class="transfer-note">默认暂停新账号的自动运行，确认凭据后可在账号设置中启用。</p></div>
    </div><div class="modal-actions transfer-actions"><button type="button" class="button secondary" data-action="close">取消</button><button id="account-import-preview-submit" class="button primary" type="submit" name="step" value="preview" disabled>预览导入</button><button id="account-import-submit" class="button primary" type="submit" name="step" value="import" hidden disabled>导入账号</button></div></form>`);
  syncAccountTransfer(transfer);
}
function invalidateAccountPreview(transfer){
  if(!accountTransferActive(transfer)||transfer.kind!=='import')return;
  transfer.generation++;transfer.controller?.abort();transfer.controller=null;transfer.busy=false;transfer.reading=false;transfer.preview=null;transfer.previewInput=null;transfer.request=null;
  $('#account-import-preview').hidden=true;$('#account-import-preview').replaceChildren();clearTransferErrors(transfer);syncAccountTransfer(transfer);
}
async function selectAccountImportFile(input){
  const transfer=accountFileTransfer;
  if(!accountTransferActive(transfer)||input.form!==transfer.form||transfer.kind!=='import')return;
  invalidateAccountPreview(transfer);transfer.file=null;transfer.encrypted=false;$('#account-import-password').value='';
  const selected=input.files?.[0],revision=transfer.generation;
  $('#account-import-filename').textContent=selected?.name||'点击选择 JSON 文件';
  $('#account-import-file-detail').textContent=selected?`${(selected.size/1024).toLocaleString('zh-CN',{maximumFractionDigits:1})} KB`:'支持普通 JSON 与密码加密备份';
  $('#account-import-file-note').textContent='预览会检查文件格式和重复账号，不会执行登录或签到。';
  syncAccountTransfer(transfer);
  if(!selected)return;
  if(!/\.json$/i.test(selected.name))return transferError(transfer,'请选择 .json 格式的账号备份文件。');
  if(!selected.size||selected.size>ACCOUNT_BACKUP_MAX_BYTES)return transferError(transfer,selected.size?'文件超过 8 MiB，请分批导入。':'文件为空，请重新选择。');
  transfer.reading=true;syncAccountTransfer(transfer);
  try{
    const raw=await selected.text();
    if(!accountTransferActive(transfer)||transfer.generation!==revision)return;
    let file;try{file=JSON.parse(raw.replace(/^\ufeff/,''));}catch{return transferError(transfer,'文件不是有效的 JSON，请检查示例格式后重试。');}
    if(!file||typeof file!=='object'||Array.isArray(file)||!['checkin-assistant-accounts','checkin-assistant-accounts-encrypted'].includes(file.format))return transferError(transfer,'这不是签到助手账号备份，请检查文件或下载示例。');
    if(file.version!==1)return transferError(transfer,'暂不支持此备份版本，请使用当前版本的账号备份。');
    transfer.file=file;transfer.encrypted=file.format==='checkin-assistant-accounts-encrypted';
    $('#account-import-file-note').textContent=transfer.encrypted?'此备份已加密，请输入导出时设置的备份密码。':'文件已就绪。先预览新增和重复账号，再确认导入。';
  }catch{if(accountTransferActive(transfer)&&transfer.generation===revision)transferError(transfer,'文件无法读取，请重新选择。');}
  finally{if(accountTransferActive(transfer)&&transfer.generation===revision){transfer.reading=false;syncAccountTransfer(transfer);if(transfer.file&&transfer.encrypted)$('#account-import-password').focus();}}
}
function renderAccountPreview(transfer,result){
  const labels={new:'将新增',duplicate:'已存在',invalid:'需修正'};
  const section=$('#account-import-preview');
  section.innerHTML=`<div class="transfer-summary"><div><b>${esc(result.new_count)}</b><span>新增账号</span></div><div><b>${esc(result.duplicate_count)}</b><span>跳过重复</span></div><div class="${result.error_count?'has-errors':''}"><b>${esc(result.error_count)}</b><span>需要修正</span></div></div>
    <div class="transfer-results" tabindex="0" role="region" aria-label="账号预览列表，可滚动"><table><thead><tr><th>账号 / 站点</th><th>凭据方式</th><th>处理结果</th></tr></thead><tbody>${(result.rows||[]).map(row=>{const status=Object.hasOwn(labels,row.status)?row.status:'invalid';return `<tr><td><b>${esc(row.name||`第 ${row.index} 个账号`)}</b><small>${esc(row.provider_name||row.provider||'未知站点')}</small></td><td>${row.auth_mode==='password'?'账号密码':row.auth_mode==='session'?'Session':'—'}</td><td><span class="transfer-result ${status}">${labels[status]}</span><small>${esc(row.message||'')}</small></td></tr>`;}).join('')}</tbody></table></div>
    ${(result.providers_to_add||[]).length?`<div class="transfer-sites"><span>同时添加 ${(result.providers_to_add||[]).length} 个站点</span>${result.providers_to_add.map(provider=>`<div><b>${esc(provider.name)}</b><small>${esc(provider.domain)}</small></div>`).join('')}</div>`:''}
    <p class="transfer-note transfer-preview-note">${result.error_count?'请先修正文件中标记的账号，再重新选择文件。':!result.new_count?'这些账号已存在，无需重复导入。':'已有账号会保留，文件中的重复账号自动跳过。'}</p>`;
  section.hidden=false;syncAccountTransfer(transfer);
}
async function submitAccountImport(form,step='preview'){
  const transfer=accountFileTransfer;
  if(!accountTransferActive(transfer)||transfer.form!==form||transfer.kind!=='import'||transfer.busy||transfer.reading)return;
  clearTransferErrors(transfer);
  if(!transfer.file)return transferError(transfer,'请先选择账号 JSON 备份。');
  const password=transfer.encrypted?$('#account-import-password').value:undefined,restore_enabled=$('#account-import-restore').checked;
  if(transfer.encrypted&&(!password||password.length<8||password.length>1024))return transferFieldError(transfer,'account-import-password','请输入导出时设置的备份密码，长度为 8 至 1024 个字符。');
  const snapshot={file:transfer.file,password,restore_enabled},revision=transfer.generation;
  if(step==='import'){
    if(!transfer.preview?.can_import||transfer.preview.error_count||!transfer.preview.new_count)return;
    if(transfer.previewInput?.file!==snapshot.file||transfer.previewInput.password!==password||transfer.previewInput.restore_enabled!==restore_enabled){invalidateAccountPreview(transfer);return transferError(transfer,'文件或设置已变化，请重新预览后导入。');}
    const previous=transfer.request;
    if(!previous||previous.file!==snapshot.file||previous.password!==password||previous.restore_enabled!==restore_enabled)transfer.request={...snapshot,id:Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,'0')).join('')};
  }
  transfer.busy=true;transfer.operation=step;transfer.controller=new AbortController();syncAccountTransfer(transfer);
  try{
    const result=await api(`/api/accounts/backup/${step==='import'?'import':'preview'}`,{method:'POST',body:{file:snapshot.file,...(password===undefined?{}:{password}),...(step==='import'?{request_id:transfer.request.id,restore_enabled}:{})},signal:transfer.controller.signal});
    if(!accountTransferActive(transfer)||transfer.generation!==revision)return;
    if(step==='preview'){
      transfer.preview=result;transfer.previewInput=snapshot;renderAccountPreview(transfer,result);
    }else{
      const imported=Number(result.imported)||0,skipped=Number(result.skipped)||0;
      closeModal();toast(`${imported?`已导入 ${imported} 个账号${restore_enabled?'':'，自动运行已暂停'}`:'没有新增账号'}${skipped?`；跳过 ${skipped} 个重复账号`:''}`);await refresh(true);
    }
  }catch(error){
    if(accountTransferActive(transfer)&&transfer.generation===revision&&error.name!=='AbortError'){
      transferError(transfer,error.message||'导入未能完成，请重试。');
      if(step==='import'&&error.definitive){transfer.preview=null;transfer.previewInput=null;$('#account-import-preview').hidden=true;$('#account-import-preview').replaceChildren();}
    }
  }finally{if(accountTransferActive(transfer)&&transfer.generation===revision){transfer.busy=false;transfer.controller=null;syncAccountTransfer(transfer);}}
}
function downloadAccountTemplate(){
  const sample={format:'checkin-assistant-accounts',version:1,exported_at:new Date().toISOString(),providers:[],accounts:[
    {name:'AnyRouter · 示例',provider:'anyrouter',auth_mode:'session',enabled:false,interval_hours:6,credentials:{session:'replace-with-session-cookie-value',api_user:'123',proxy:{mode:'default'}}},
    {name:'AgentRouter · 示例',provider:'agentrouter',auth_mode:'password',enabled:false,interval_hours:6,credentials:{email:'your-name-or-email',password:'replace-with-site-password',proxy:{mode:'default'}}},
  ]};
  downloadAccountJson(sample,'checkin-assistant-accounts-example.json',true);toast('示例已下载，请替换示例凭据后再导入。');
}
function queueActive(queue){return !!queue&&state.loginQueue===queue&&!queue.stopped&&!queue.done;}
function userSiteUrl(providerId){
 const provider=allProviders().find(p=>p.id===providerId);
 if(!provider)return null;
 try{
  const origin=new URL(provider.domain),url=new URL(provider.login_path||'/login',origin);
  if(!['https:','http:'].includes(origin.protocol)||origin.username||origin.password||url.origin!==origin.origin)return null;
  return url.href;
 }catch{return null;}
}
function updateUserConnection(queue,result){
 if(!userBrowserAuthorization())return;
 queue.connection=result.connection||queue.connection||null;
 queue.expiresAt=result.expires_at||queue.expiresAt||null;
}
function clearBrowserImportFields(){
 $('#browser-import-form')?.reset();
}
function restoreAuthorization(current){
 if(!current||!state.data?.web?.enabled||queueActive(state.loginQueue)||!['starting','waiting','verifying'].includes(current.status))return;
 const queue={options:{method:current.method,name:current.name||'',account_id:current.account_id||null,interval_hours:6},items:[{provider:current.provider,status:'waiting',message:current.message||'已恢复当前连接，请填写本站登录状态。'}],index:0,session:current.id,stopped:false,done:false,starting:false,polling:false,cancelling:false,recovered:true};
 state.loginQueue=queue;state.loginSession=current.id;updateUserConnection(queue,current);renderLoginQueue(queue);void pollLogin(queue);
}
function launchLogin(options,selected=[options.provider]){
  if(state.loginQueue&&!state.loginQueue.stopped&&!state.loginQueue.done)return;
  const queue={options,items:selected.map(provider=>({provider,status:'pending',message:'等待连接'})),index:0,session:null,stopped:false,done:false,starting:false,polling:false,cancelling:false};
  state.loginQueue=queue;
  void startQueueItem(queue);
}
function renderLoginQueue(queue){
 if(state.loginQueue!==queue||queue.stopped)return;
 const item=queue.items[queue.index],finished=queue.items.filter(i=>i.status==='success').length;
 const statuses={pending:'等待',starting:'准备中',waiting:'等待填写',verifying:'正在校验',success:'已保存',error:'未完成',network:'连接中断',unknown:'待确认',skipped:'已跳过'};
 const progress=`<ol class="platform-progress" aria-live="polite">${queue.items.map((entry,index)=>`<li class="${esc(entry.status)} ${index===queue.index&&!queue.done?'current':''}"><div><b>${providerName(entry.provider)}</b><span>${statuses[entry.status]||esc(entry.status)}</span></div><p>${esc(entry.message)}</p></li>`).join('')}</ol>`;
 const actions=queue.done?'<button class="button primary" data-action="close">完成</button>':`<button class="button secondary" data-action="cancel-login">取消连接</button>${item.status==='error'?'<button class="button primary" data-action="close">关闭并重新填写</button>':''}${item.status==='network'?'<button class="button primary" data-action="retry-poll">查询当前连接</button>':''}`;
 if(!$('#queue-progress'))modal(`<div class="modal-head"><div><h2 id="dialog-title"></h2><p id="queue-subtitle"></p></div><button class="icon-button" data-action="close" aria-label="关闭">${icon('x')}</button></div><div id="queue-progress"></div><section id="user-browser-authorization" class="user-browser-authorization" aria-label="手动填写登录状态" hidden><p id="user-browser-agent-hint" class="browser-agent-hint" hidden>AgentRouter：Session 和用户 ID 可同步余额，不代表已领取登录奖励。</p><div id="manual-browser-import" class="browser-manual-import"><form id="browser-import-form" novalidate><div class="form-errors-summary" role="alert" hidden></div><div class="field"><label for="browser-import-session" id="browser-import-session-label">Session Cookie</label><input id="browser-import-session" name="session" type="password" required maxlength="32000" autocomplete="off" placeholder="本站 session Cookie 原值"></div><div class="field"><label for="browser-import-user">站内用户 ID</label><input id="browser-import-user" name="api_user" required maxlength="100" inputmode="numeric" pattern="[1-9][0-9]*" autocomplete="off" placeholder="本站 user 中的 id"></div><details class="credential-help"><summary>如何获取本站登录状态</summary><p id="browser-import-instructions"></p><a id="user-browser-site" class="panel-link" target="_blank" rel="noopener noreferrer">打开站点登录页 ${icon('link')}</a></details><button class="button primary small" type="submit" id="browser-import-submit">校验并保存</button></form></div></section><div class="modal-actions" id="queue-actions"></div>`);
 $('#dialog-title').textContent=queue.done?'连接结果':'填写登录状态';
 $('#queue-subtitle').innerHTML=queue.done?`${finished} / ${queue.items.length} 个站点已保存`:`${queue.recovered?'已恢复当前连接':'当前连接'} · ${providerName(item.provider)}`;
 $('#queue-progress').innerHTML=progress;$('#queue-actions').innerHTML=actions;
 const section=$('#user-browser-authorization');section.hidden=queue.done||!queue.session||item.status==='error';
 if(queue.session){
  const form=$('#browser-import-form'),provider=allProviders().find(p=>p.id===item.provider),sub2api=provider?.template?.startsWith('sub2api');
  if(form.dataset.session!==queue.session){form.reset();form.dataset.session=queue.session;$('.form-errors-summary',form).hidden=true;}
  $('#user-browser-site').href=userSiteUrl(item.provider)||'#';
  $('#browser-import-submit').disabled=!!queue.importing||item.status==='verifying';
  $('#browser-import-submit').textContent=queue.importing||item.status==='verifying'?'正在校验…':'校验并保存';
  $('#user-browser-agent-hint').hidden=item.provider!=='agentrouter';
  $('#browser-import-instructions').textContent=sub2api?'在本站开发者工具 Application → Local Storage 复制 auth_token，在 user 中查看 id。请填写登录 Token，不是模型 API Key。':'在本站开发者工具 Application → Cookies 复制 session 的原值，在 Local Storage → user 查看 id。只填字段值，不粘贴整段 Cookie 请求头。';
  $('#browser-import-session-label').textContent=sub2api?'登录 Token（不是 API Key）':'Session Cookie';
  $('#browser-import-session').placeholder=sub2api?'本站 Local Storage 中 auth_token 的值':'本站 session Cookie 原值';
 }
}
async function startQueueItem(queue){
  if(!queueActive(queue)||queue.starting)return;
  const item=queue.items[queue.index];
  queue.starting=true;
  item.status='starting';item.message='正在准备账号校验…';
  renderLoginQueue(queue);
  try{
    const res=await api('/api/login/start',{method:'POST',body:{...queue.options,provider:item.provider}});
    if(!res.id)throw new Error('服务未返回连接会话编号，结果尚无法确认');
    queue.session=res.id;
    if(!queueActive(queue)){await cancelLoginSession(queue,res.id);return;}
    state.loginSession=res.id;
    updateUserConnection(queue,res);
    item.status='waiting';item.message=res.message||'请填写本站登录状态，校验通过后保存。';
    renderLoginQueue(queue);
    void pollLogin(queue);
  }catch(error){
    if(!queueActive(queue)){toast('连接请求结果尚未确认，请检查账号列表；队列已停止。');return;}
    if(error.definitive)queue.connection=null;
    item.status=error.definitive?'error':'unknown';
    item.message=error.definitive?error.message:`网络或响应异常：${error.message}。请求可能已到达服务，请先核对账号列表。`;
    renderLoginQueue(queue);
  }finally{queue.starting=false;}
}
async function pollLogin(queue){
  if(!queueActive(queue)||queue.polling||!queue.session)return;
  queue.polling=true;
  const id=queue.session,item=queue.items[queue.index];
  try{
    const result=await api(`/api/login/${encodeURIComponent(id)}`);
    if(!queueActive(queue)||queue.session!==id)return;
    updateUserConnection(queue,result);
    item.message=result.message||'等待当前站点完成登录与导入…';
    if(result.status==='success'){
      await finishQueueItem(queue,id,result);
      return;
    }
    if(['error','cancelled','expired','unavailable','failed'].includes(result.status)){
      item.status='error';queue.session=null;queue.connection=null;state.loginSession=null;
      clearBrowserImportFields();
      if(result.status==='unavailable')item.message=result.message||`平台不支持或未提供 ${methodName(queue.options.method)} 入口。`;
      renderLoginQueue(queue);return;
    }
    item.canResume=!!result.verification_paused;item.canContinueOAuth=!!result.oauth_continue_available;
    item.status=userBrowserAuthorization()?(result.status==='verifying'?'verifying':'waiting'):result.stage==='linuxdo_home'?'oauth_home':result.stage==='resuming_oauth'?'oauth_returning':result.stage==='native_login'?'native':result.verification_auto?'detecting':result.verification_paused?'blocked':'waiting';renderLoginQueue(queue);
    loginPoll=setTimeout(()=>pollLogin(queue),1000);
  }catch(error){
    if(!queueActive(queue)||queue.session!==id)return;
    item.status='network';item.message=`查询失败：${error.message}。可重试查询同一会话，不会再次创建连接。`;
    renderLoginQueue(queue);
  }finally{
    queue.polling=false;
    if(queueActive(queue)&&queue.session&&queue.session!==id){
      clearTimeout(loginPoll);loginPoll=setTimeout(()=>pollLogin(queue),0);
    }
  }
}
async function finishQueueItem(queue,id,result){
 if(!queueActive(queue)||queue.session!==id)return;
 const item=queue.items[queue.index];
 item.status='success';item.message=result.message||'本站身份已确认，登录状态已加密保存。';
 queue.session=null;queue.connection=null;state.loginSession=null;clearBrowserImportFields();
 renderLoginQueue(queue);await refresh(true);
 if(queueActive(queue))advanceQueue(queue);
}
async function submitBrowserImport(form){
 const queue=state.loginQueue,id=form.dataset.session;
 if(!queueActive(queue)||!id||queue.session!==id||queue.importing||queue.items[queue.index].status==='verifying')return;
 const summary=$('.form-errors-summary',form),data=Object.fromEntries(new FormData(form));
 summary.hidden=true;
 const session=(data.session||'').trim(),api_user=(data.api_user||'').trim();
 if(!session||!(/^[1-9][0-9]*$/).test(api_user))throw new Error('请填写本站登录凭据和有效的数字用户 ID。');
 queue.importing=true;renderLoginQueue(queue);
 try{
  const result=await api(`/api/login/${encodeURIComponent(id)}/import`,{method:'POST',body:{session,api_user}});
  if(!queueActive(queue)||queue.session!==id)return;
  if(result.status==='success')await finishQueueItem(queue,id,result);
  else{queue.items[queue.index].status=result.status==='verifying'?'verifying':'waiting';queue.items[queue.index].message=result.message||'正在确认本站身份…';renderLoginQueue(queue);}
 }catch(error){
  if(queueActive(queue)&&queue.session===id){summary.hidden=false;summary.textContent=error.message;}
 }finally{queue.importing=false;if(queueActive(queue)&&queue.session===id)renderLoginQueue(queue);}
}
function advanceQueue(queue){
  if(!queueActive(queue))return;
  if(queue.index+1>=queue.items.length){queue.done=true;queue.connection=null;renderLoginQueue(queue);return;}
  queue.index++;
  // 等当前轮询退出后才发起下一平台，避免共享状态与轮询重叠。
  loginPoll=setTimeout(()=>startQueueItem(queue),0);
}
async function cancelLoginSession(queue,id){
  if(queue.cancelling)return;
  queue.cancelling=true;
  try{
    const result=await api(`/api/login/${encodeURIComponent(id)}/cancel`,{method:'POST',body:{}});
    if(result.status==='success')toast('队列已停止；当前平台在取消前已保存，账号会保留。');
    else toast('队列已停止，已完成的账号保留。');
    if(queue.session===id)queue.session=null;
    await refresh(true);
  }catch(error){toast(`队列已停止，但取消连接尚未确认：${error.message}。请查询当前连接状态。`);}
  finally{queue.cancelling=false;}
}
async function toggleScheduler(){const s=state.data.settings;await api('/api/settings',{method:'PATCH',body:{scheduler_enabled:!s.scheduler_enabled,interval_hours:s.interval_hours}});await refresh(true);toast(!s.scheduler_enabled?'自动签到已启用':'自动签到已暂停');}
document.addEventListener('click',async e=>{const btn=e.target.closest('button');if(!btn)return;try{
 if(btn.dataset.view){state.view=btn.dataset.view;location.hash=state.view;render();} else if(btn.dataset.logFilter){state.logFilter=btn.dataset.logFilter;render();}
 else if(btn.dataset.filter){state.filter=btn.dataset.filter;render();}
 else if(btn.dataset.method){state.loginMethod=btn.dataset.method;state.reauth=isBrowser(btn.dataset.method);syncMethod();}
 else if(btn.dataset.action==='select-all-platforms'){state.selectedProviders=eligibleProviders().map(p=>p.id);platformPicker();}
 else if(btn.dataset.action==='cancel-login')closeModal();
 else if(btn.dataset.action==='retry-login'){const q=state.loginQueue;if(queueActive(q)&&q.items[q.index].status==='error')void startQueueItem(q);}
 else if(btn.dataset.action==='skip-login'){const q=state.loginQueue;if(queueActive(q)&&q.items[q.index].status==='error'){q.items[q.index].status='skipped';advanceQueue(q);}}
 else if(btn.dataset.action==='resume-login'){const q=state.loginQueue;if(queueActive(q)&&q.session){await api(`/api/login/${encodeURIComponent(q.session)}/resume`,{method:'POST',body:{}});q.items[q.index].status='waiting';q.items[q.index].message='正在重新校验目标平台身份…';renderLoginQueue(q);}}
 else if(btn.dataset.action==='continue-oauth'){const q=state.loginQueue;if(queueActive(q)&&q.session&&q.items[q.index].canContinueOAuth){q.items[q.index].canContinueOAuth=false;q.items[q.index].status='oauth_returning';q.items[q.index].message='正在返回原站点继续授权…';renderLoginQueue(q);await api(`/api/login/${encodeURIComponent(q.session)}/continue-oauth`,{method:'POST',body:{}});}}
 else if(btn.dataset.action==='retry-poll'){const q=state.loginQueue;if(queueActive(q)&&q.items[q.index].status==='network')void pollLogin(q);}
 else if(btn.dataset.action==='connect-platform'){const a=state.data.accounts.find(x=>x.id===Number(btn.dataset.id));if(a&&isOAuth(a.login_via))accountModal(null,a);}
 else if(btn.dataset.action==='relogin'){const a=state.data.accounts.find(x=>x.id===Number(btn.dataset.id));if(!a)return;accountModal(a);state.reauth=true;syncMethod();}
 else if(btn.dataset.exportFormat){const transfer=accountFileTransfer;if(accountTransferActive(transfer)&&transfer.kind==='export'&&!transfer.busy){transfer.generation++;transfer.encrypted=btn.dataset.exportFormat==='encrypted';for(const input of $$('#account-export-passwords input'))input.value='';clearTransferErrors(transfer);syncAccountTransfer(transfer);}}
 else if(btn.dataset.action==='accounts-import')accountImportModal();
 else if(btn.dataset.action==='accounts-export')accountExportModal();
 else if(btn.dataset.action==='accounts-template')downloadAccountTemplate();
 else if(btn.dataset.action==='add')accountModal();
 else if(btn.dataset.action==='close')closeModal();
 else if(btn.dataset.action==='settings')settingsModal();
 else if(btn.dataset.action==='admin-settings')adminModal();
 else if(btn.dataset.action==='about')aboutModal();
 else if(btn.dataset.action==='refresh-page')await refresh(false);
 else if(btn.dataset.action==='logout')await logout();
 else if(btn.dataset.action==='password-settings')passwordModal();
 else if(btn.dataset.action==='edit')accountModal(state.data.accounts.find(a=>a.id===Number(btn.dataset.id)));
 else if(btn.dataset.action==='run'){btn.disabled=true;await api(`/api/accounts/${btn.dataset.id}/run`,{method:'POST',body:{}});toast('已加入签到队列，正在连接站点');await refresh(true);}
 else if(btn.dataset.action==='run-all'){if(!state.data.accounts.some(a=>a.enabled))return toast('请先添加并启用一个账号');btn.disabled=true;const r=await api('/api/run-all',{method:'POST',body:{}});toast(r.queued?`已启动 ${r.queued} 个签到任务`:'任务已在执行中');await refresh(true);}
 else if(btn.dataset.action==='toggle-scheduler')await toggleScheduler();
 else if(btn.dataset.action==='modal-switch'){btn.classList.toggle('on');const enabled=btn.classList.contains('on');btn.setAttribute('aria-pressed',String(enabled));$('input[name="scheduler_enabled"]').value=enabled;}
 else if(btn.dataset.action==='toggle-account-enabled'){const a=state.data.accounts.find(x=>x.id===Number(btn.dataset.id));if(!a)return;btn.disabled=true;const enabled=!a.enabled;await api(`/api/accounts/${a.id}`,{method:'PUT',body:{enabled}});a.enabled=enabled;if(state.editing?.id===a.id)state.editing.enabled=enabled;btn.classList.toggle('on',enabled);btn.setAttribute('aria-pressed',String(enabled));toast(enabled?'此账号自动运行已启用':'此账号自动运行已暂停');await refresh(true);}
 else if(btn.dataset.action==='delete'){const a=state.data.accounts.find(x=>x.id===Number(btn.dataset.id));modal(`<div class="modal-head"><div><h2>删除账号？</h2><p>将从服务器删除「${esc(a.name)}」的加密凭据与调度。</p></div></div><div class="notice">${icon('info')}已有运行日志会保留账号名称快照。此操作无法撤销，但不会影响站点上的账号。</div><div class="modal-actions"><button class="button secondary" data-action="close">取消</button><button class="button danger-fill" data-action="confirm-delete" data-id="${a.id}">确认删除</button></div>`,{destructive:true});}
 else if(btn.dataset.action==='confirm-delete'){await api(`/api/accounts/${btn.dataset.id}`,{method:'DELETE',body:{}});closeModal();toast('账号及其保存凭据已删除');await refresh(true);}
 else if(btn.dataset.action==='export'){const a=document.createElement('a');a.href='/api/logs/export';a.download='checkin-assistant-logs.csv';a.click();toast('已导出当前日志');}
 else if(btn.dataset.action==='log')logModal(state.data.runs.find(x=>x.id===Number(btn.dataset.id)));
 }catch(err){const summary=$('#modal[role="alertdialog"] .form-errors-summary');if(summary){summary.hidden=false;summary.textContent=err.message||'操作未完成，请重试。';}else toast(err.message||'操作未完成');await refresh(true);}finally{if(btn.isConnected)btn.disabled=false;}});
document.addEventListener('submit',async e=>{e.preventDefault();const submit=e.submitter;if(submit)submit.disabled=true;try{if(e.target.id==='auth-form')await submitAuth(e.target);if(e.target.id==='password-form')await submitPassword(e.target);if(e.target.id==='account-form')await saveAccount(e.target);if(e.target.id==='account-export-form')await exportAccountFile(e.target);if(e.target.id==='account-import-form')await submitAccountImport(e.target,submit?.value||'preview');if(e.target.id==='browser-import-form')await submitBrowserImport(e.target);if(e.target.id==='provider-form')await saveProvider(e.target);if(e.target.id==='settings-form'){const body=Object.fromEntries(new FormData(e.target));body.scheduler_enabled=body.scheduler_enabled==='true';body.interval_hours=Number(body.interval_hours);await api('/api/settings',{method:'PATCH',body});closeModal();toast('定时设置已保存');await refresh(true);}}catch(err){const summary=$('.form-errors-summary',e.target);if(summary){summary.hidden=false;summary.textContent=err.message;}else toast(err.message);}finally{if(submit?.isConnected){if(['account-export-form','account-import-form'].includes(e.target.id))syncAccountTransfer(accountFileTransfer);else if(e.target.id==='browser-import-form'&&queueActive(state.loginQueue))renderLoginQueue(state.loginQueue);else submit.disabled=false;}}});
document.addEventListener('input',e=>{if(e.target.id==='account-search'){state.query=e.target.value;const pos=e.target.selectionStart;render();const input=$('#account-search');input.focus();input.setSelectionRange(pos,pos);}});
document.addEventListener('change',e=>{
  if(e.target.id==='account-import-file')void selectAccountImportFile(e.target).catch(()=>transferError(accountFileTransfer,'文件读取未完成，请重新选择。'));
  if(e.target.id==='account-import-restore')invalidateAccountPreview(accountFileTransfer);
  if(e.target.id==='account-export-scope'){if(accountFileTransfer)accountFileTransfer.generation++;clearTransferErrors(accountFileTransfer);syncAccountTransfer(accountFileTransfer);}
  if(e.target.id==='currency-picker'){state.currency=e.target.value;render();}
  if(['proxy_mode','proxy_auth','proxy_server'].includes(e.target.name))syncProxy();
  if(e.target.name==='providers'){state.selectedProviders=$$('input[name="providers"]:checked').map(input=>input.value);updateAccountSubmit();}
  if(e.target.name==='provider'&&!state.editing){state.selectedProviders=[e.target.value];updateAccountSubmit();}
});
document.addEventListener('input',e=>{if(e.target.name==='proxy_server')syncProxy();});
document.addEventListener('input',e=>{if(e.target.id==='account-import-password')invalidateAccountPreview(accountFileTransfer);if(e.target.form?.id==='auth-form')clearAuthErrors(e.target.form);});
for(const event of ['input','change'])document.addEventListener(event,e=>{
  const form=e.target.closest('#account-form');
  if(form?.dataset.validationAttempted)validateAccountForm(form,false);
});
$('#modal').addEventListener('click',e=>{if(e.target===$('#modal'))closeModal();});
$('#modal').addEventListener('cancel',e=>{e.preventDefault();closeModal();});
$('#modal').addEventListener('close',()=>{if(!$('#modal').open)disposeAccountTransfer();});
window.__checkinEnabledAccounts=()=>state.data?state.data.accounts.filter(a=>a.enabled).length:0;

async function returnToLogin(){
 disposeAccountTransfer();
 stopLoginPoll();const queue=state.loginQueue;if(queue){queue.stopped=true;queue.connection=null;}clearBrowserImportFields();state.loginQueue=null;state.loginSession=null;state.data=null;if($('#modal').open)$('#modal').close();
 state.auth={...(state.auth||{}),web_mode:true,authenticated:false,configured:true};$('#workspace-shell').hidden=true;renderAuth();
 try{state.auth=await api('/api/auth/status');renderAuth();}catch{}
}
function authBrand(){return `<a class="brand" href="#overview" aria-label="签到助手"><span class="brand-mark">${icon('checkin')}</span><span>签到助手</span></a>`;}
function renderAuth(){
 const setup=!!state.auth?.setup_required;
 $('#auth-screen').hidden=false;$('#workspace-shell').hidden=true;
 $('#auth-screen').innerHTML=`<aside class="auth-story">${authBrand()}<div class="auth-copy"><span class="auth-eyebrow">每天少一件小事</span><h1>把每天的签到，<br>交给签到助手。</h1><p>连接常用站点，自动完成签到。<br>把额度、账号和运行记录，整理在一起。</p><div class="auth-calendar" aria-hidden="true"><span class="calendar-caption">每天，井井有条</span><div class="calendar-week">${['一','二','三','四','五','六','日'].map((day,i)=>`<span class="calendar-day ${i<5?'checked':''}"><small>${day}</small>${icon(i<5?'checkplain':'dots')}</span>`).join('')}</div><span class="calendar-foot">签到 <i>·</i> 同步 <i>·</i> 记录</span></div><ul class="auth-capabilities"><li>${icon('layers')}多个站点，独立管理</li><li>${icon('clock')}后台定时，自动运行</li><li>${icon('shield')}自托管，凭据加密保存</li></ul></div><div class="auth-footnote">一个属于自己的签到工作空间</div></aside>
 <div class="auth-form-side"><div class="auth-form-wrap"><span class="auth-label">${setup?'首次使用':'欢迎回来'}</span><h2>${setup?'设置登录账号':'登录签到助手'}</h2><p>${setup?'首次使用，请设置账号和密码。以后使用这组凭据登录。':'登录你的工作空间，查看今天的签到。'}</p><form id="auth-form" data-setup="${setup}" novalidate><div id="auth-form-error" class="form-errors-summary" role="alert" hidden></div><div class="field"><label for="auth-username">登录账号</label><input id="auth-username" name="username" required autocomplete="username" ${setup?'minlength="2" maxlength="40" aria-describedby="auth-username-help"':'maxlength="100"'} placeholder="${setup?'设置你的登录账号':'输入登录账号'}" autocapitalize="none" spellcheck="false">${setup?'<p id="auth-username-help" class="field-help">2–40 个英文字母、数字、点、下划线或连字符。</p>':''}</div><div class="field"><label for="auth-password">${setup?'设置登录密码':'登录密码'}</label><input id="auth-password" name="password" type="password" required ${setup?'minlength="12" aria-describedby="auth-password-help"':''} maxlength="2048" autocomplete="${setup?'new-password':'current-password'}" placeholder="${setup?'至少 12 个字符':'输入登录密码'}">${setup?'<p id="auth-password-help" class="field-help">12–1024 个字符，包含字母、数字或符号中的至少两类。</p>':''}</div>${setup?'<div class="field"><label for="auth-confirm">确认密码</label><input id="auth-confirm" name="confirm_password" type="password" required minlength="12" maxlength="2048" autocomplete="new-password" placeholder="再次输入登录密码"></div>':''}<button class="button primary" type="submit">${setup?'设置并进入控制台':'登录工作空间'}${icon('arrow')}</button></form><div class="auth-form-footer">${icon('shield')}在你自己的服务器上，安全保存账号凭据。</div></div><div class="auth-bottom">签到助手 <span>·</span> 自托管的签到与额度管理</div></div>`;
}
function clearAuthErrors(form){
 const summary=$('#auth-form-error',form);if(summary){summary.hidden=true;summary.textContent='';}
 for(const input of $$('input',form)){input.removeAttribute('aria-invalid');const described=(input.getAttribute('aria-describedby')||'').split(/\s+/).filter(id=>id&&id!=='auth-form-error');if(described.length)input.setAttribute('aria-describedby',described.join(' '));else input.removeAttribute('aria-describedby');}
}
function authFormError(form,message,fields){
 const summary=$('#auth-form-error',form);summary.textContent=message;summary.hidden=false;
 for(const field of fields){const input=$(`#${field}`,form);if(!input)continue;input.setAttribute('aria-invalid','true');const described=new Set((input.getAttribute('aria-describedby')||'').split(/\s+/).filter(Boolean));described.add('auth-form-error');input.setAttribute('aria-describedby',[...described].join(' '));}
 $(`#${fields[0]}`,form)?.focus();
}
function validSetupPassword(password){
 const length=Array.from(password).length,groups=[/\p{L}/u.test(password),/\p{N}/u.test(password),/[^\p{L}\p{N}\s]/u.test(password)];
 const common=['password1234','password12345','password123456','admin12345678','checkinassistant12345','changeme12345','changemenow','replacethispassword','replacewithasecurepassword','yourpasswordhere'];
 return length>=12&&length<=1024&&groups.filter(Boolean).length>=2&&!common.includes(password.toLowerCase().replace(/[^a-z0-9]/g,''));
}
async function submitAuth(form){
 const data=Object.fromEntries(new FormData(form)),setup=form.dataset.setup==='true';clearAuthErrors(form);
 const missing=[...(!data.username?.trim()?['auth-username']:[]),...(!data.password?['auth-password']:[]),...(setup&&!data.confirm_password?['auth-confirm']:[])];
 if(missing.length)return authFormError(form,setup?'请填写完整的登录账号、密码和确认密码。':'请填写完整的登录账号和密码。',missing);
 if(setup&&!/^[A-Za-z0-9_.-]{2,40}$/.test(data.username.trim()))return authFormError(form,'登录账号须为 2–40 个英文字母、数字、点、下划线或连字符。',['auth-username']);
 if(setup&&!validSetupPassword(data.password))return authFormError(form,'登录密码须为 12–1024 个字符，包含字母、数字或符号中的至少两类，并避免常见默认密码。',['auth-password']);
 if(setup&&data.password!==data.confirm_password)return authFormError(form,'两次输入的密码不一致。',['auth-confirm']);
 if(!setup&&Array.from(data.password).length>1024)return authFormError(form,'登录密码不能超过 1024 个字符。',['auth-password']);
 const submit=$('[type="submit"]',form),markup=submit.innerHTML;submit.textContent=setup?'正在设置登录账号':'正在登录';form.setAttribute('aria-busy','true');
 try{const result=await api(setup?'/api/auth/setup':'/api/auth/login',{method:'POST',body:{username:data.username.trim(),password:data.password}});state.auth={...(state.auth||{}),...result,authenticated:true,configured:true,web_mode:true,setup_required:false};$('#auth-screen').hidden=true;$('#workspace-shell').hidden=false;state.data=null;state.authorizationChecked=false;await refresh(false);}
 catch(error){
  if(setup&&error.status===409){
   let auth;try{auth=await api('/api/auth/status');}catch{}
   if(auth?.configured&&!auth.setup_required){state.auth=auth;state.data=null;state.authorizationChecked=false;if(auth.authenticated){$('#auth-screen').hidden=true;$('#workspace-shell').hidden=false;await refresh(false);return;}renderAuth();$('#auth-username').value=data.username.trim();authFormError($('#auth-form'),'登录账号已经设置，请使用已设置的账号和密码登录。',['auth-username','auth-password']);return;}
  }
  if(form.isConnected)authFormError(form,error.message,['auth-username','auth-password']);
 }
 finally{form.removeAttribute('aria-busy');if(submit.isConnected)submit.innerHTML=markup;}
}
async function logout(){await api('/api/auth/logout',{method:'POST',body:{}});disposeAccountTransfer();if($('#modal').open)$('#modal').close();state.data=null;state.auth={...state.auth,authenticated:false};renderAuth();}
function adminModal(){const username=state.auth?.username||'管理员';modal(`<div class="modal-head"><div><h2>工作空间设置</h2><p>管理你的控制台登录账号。</p></div><button class="icon-button" data-action="close" aria-label="关闭">${icon('x')}</button></div><div class="admin-summary"><span class="user-avatar">${esc(username.slice(0,1).toUpperCase())}</span><div><b>${esc(username)}</b><small>工作空间管理员</small></div></div><div class="admin-actions"><button class="button secondary" data-action="password-settings">${icon('key')}修改登录密码</button><button class="button ghost danger" data-action="logout">${icon('logout')}退出当前登录</button></div>`);}
function passwordModal(){modal(`<div class="modal-head"><div><h2>修改登录密码</h2><p>更新后其他设备需使用新密码重新登录。</p></div><button class="icon-button" data-action="close" aria-label="关闭">${icon('x')}</button></div><form id="password-form"><div class="form-errors-summary" role="alert" hidden></div><div class="field"><label for="current-password">当前密码</label><input id="current-password" name="current_password" type="password" required autocomplete="current-password"></div><div class="field"><label for="new-password">新密码</label><input id="new-password" name="new_password" type="password" required minlength="12" maxlength="1000" autocomplete="new-password" placeholder="至少 12 个字符，组合字母、数字或符号"></div><div class="field"><label for="confirm-password">确认新密码</label><input id="confirm-password" name="confirm_password" type="password" required minlength="12" autocomplete="new-password"></div><div class="modal-actions"><button type="button" class="button secondary" data-action="close">取消</button><button class="button primary" type="submit">更新密码</button></div></form>`);}
async function submitPassword(form){const data=Object.fromEntries(new FormData(form));if(data.new_password!==data.confirm_password)throw new Error('两次输入的新密码不一致。');const result=await api('/api/auth/password',{method:'POST',body:{current_password:data.current_password,new_password:data.new_password}});state.auth={...state.auth,...result};closeModal();toast('登录密码已更新，其他设备需重新登录。');await refresh(true);}
function aboutModal(){modal(`<div class="modal-head"><div><h2>数据与运行说明</h2><p>了解工作空间如何处理账号与额度。</p></div><button class="icon-button" data-action="close" aria-label="关闭">${icon('x')}</button></div><div class="about-grid"><section><h3>每个平台独立连接</h3><p>站点 Session、站内用户标识和网络代理分别保存。GitHub 与 LinuxDO 是登录身份，连接多个站点仍需逐个平台授权。AgentRouter 的 OAuth 上游会话用于后续后台登录。</p></section><section><h3>金额与签到分开确认</h3><p>余额来自站点用户接口。签到成功需要站点确认；余额已同步只表示查询成功。奖励无法核对时显示未知，查询失败时保留已有余额。</p></section><section><h3>凭据与用户浏览器</h3><p>${userBrowserAuthorization()?'直接填写本站 Session / 登录 Token 与用户 ID，后台只读校验后保存。也可保存本站账号密码，由任务运行时登录验证；本站未设置密码的第三方登录账号请用 Session。网页无需本机连接器或浏览器扩展。':'请本人在登录窗口完成密码、验证码与授权确认。'}账号凭据加密保存在应用数据库中，备份时应同时保存数据库与加密密钥。</p></section><section><h3>后台运行</h3><p>服务运行期间按账号间隔执行任务。关闭网页不会停止调度；服务器停止时任务暂停。网站要求人工验证时，请主动重新连接处理。</p></section></div><div class="modal-actions"><button class="button primary" data-action="close">知道了</button></div>`);}
function logModal(r){if(!r)return;modal(`<div class="modal-head"><div><h2>${esc(r.account_name)}</h2><p>${providerName(r.provider)} · ${timeLabel(r.started_at,true)}</p></div><button class="icon-button" data-action="close" aria-label="关闭">${icon('x')}</button></div><div class="log-detail-grid"><div><span>运行结果</span>${statusBadge(r.status)}</div><div><span>触发方式</span><b>${r.trigger==='manual'?'手动运行':'定时运行'}</b></div><div><span>签到前余额</span><b>${money(r.before_balance,r.currency)}</b></div><div><span>签到后余额</span><b>${money(r.after_balance,r.currency)}</b></div><div><span>可确认新增额度</span><b>${r.reward==null?'奖励未知':money(r.reward,r.currency)}</b></div><div><span>运行耗时</span><b>${r.duration_ms==null?'未知':(r.duration_ms/1000).toFixed(1)+' 秒'}</b></div></div><div class="log-description">${esc(r.message)}</div><div class="modal-actions"><button class="button primary" data-action="close">完成</button></div>`);}
async function init(){
 const hash=location.hash.slice(1);if(['overview','accounts','sites','logs'].includes(hash))state.view=hash;
 try{state.auth=await api('/api/auth/status');if(state.auth.authenticated){$('#auth-screen').hidden=true;$('#workspace-shell').hidden=false;await refresh(false);}else renderAuth();}
 catch(error){if(error.status===404){state.auth={authenticated:true,web_mode:false};await refresh(false);}else{connectionStatus(false);toast('服务连接未完成，请刷新后重试。');}}
 refreshTimer=setTimeout(refreshLoop,5000);
}
async function refreshLoop(){if(document.visibilityState!=='hidden'&&state.auth?.authenticated!==false)await refresh(true);refreshTimer=setTimeout(refreshLoop,5000);}
window.addEventListener('hashchange',()=>{const view=location.hash.slice(1);if(['overview','accounts','sites','logs'].includes(view)&&state.data){state.view=view;render();}});
void init();
