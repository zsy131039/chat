// ============ 配置区 ============
const SUPABASE_URL = 'https://wewivxsxrmhqeglyhjkj.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_sBYmEDVie3VOjQyxoeJ5Pw_mZaD06vr'; 

// 检查库是否加载成功
if (typeof supabase === 'undefined') {
    alert('Supabase 库加载失败！请检查网络或刷新页面。');
    throw new Error('Supabase library not loaded');
}

// 创建客户端，使用 supabaseClient 命名避免与全局 supabase 冲突
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ============ 状态 ============
let currentUser = null;
let currentGroup = null;
let currentTab = 'chats';
let presenceChannel = null;

// ============ 工具函数 ============
// 国内快速且支持 HTTPS 的 IP 归属地接口
async function fetchLocation() {
  try {
    const res = await fetch('https://api.vore.top/api/IPdata');
    const data = await res.json();
    if (data.ipdata) {
      return `${data.ipdata.info1} · ${data.ipdata.info2} · ${data.ipdata.info3}`;
    }
  } catch (e) { 
    console.warn('IP 归属地获取失败', e); 
  }
  return '未知位置';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatTime(ts) {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
}

// ============ 登录 ============
document.getElementById('loginBtn').addEventListener('click', async () => {
  const name = document.getElementById('usernameInput').value.trim();
  if (!name) return alert('请输入名称');
  
  const location = await fetchLocation();
  currentUser = { name, location };

  // 写入 Supabase
  const { error } = await supabaseClient
    .from('profiles')
    .upsert({ name, location, last_seen: new Date().toISOString() });

  if (error) {
    alert('登录失败，请检查 Supabase 数据库和 RLS 权限：\n' + error.message);
    return;
  }

  localStorage.setItem('chat_user', JSON.stringify(currentUser));
  enterApp();
});

// 自动恢复登录状态
(async function tryRestore() {
  const saved = localStorage.getItem('chat_user');
  if (saved) {
    currentUser = JSON.parse(saved);
    await supabaseClient.from('profiles').update({ last_seen: new Date().toISOString() }).eq('name', currentUser.name);
    enterApp();
  }
})();

async function enterApp() {
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('currentUserName').textContent = currentUser.name;
  document.getElementById('userLocation').textContent = currentUser.location;
  document.getElementById('myAvatar').textContent = currentUser.name.charAt(0).toUpperCase();

  initPresence();
  initGroupsRealtime();
  
  const { data: groups } = await supabaseClient.from('groups').select('*').order('created_at', { ascending: true }).limit(1);
  if (groups && groups.length > 0) {
    selectGroup(groups[0].id, groups[0].name);
  }
}

// ============ 在线状态 ============
function initPresence() {
  presenceChannel = supabaseClient.channel('online-users', {
    config: { presence: { key: currentUser.name } }
  });

  presenceChannel
    .on('presence', { event: 'sync' }, () => {
      const state = presenceChannel.presenceState();
      const onlineUsers = Object.values(state).flat();
      renderContacts(onlineUsers);
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await presenceChannel.track({
          name: currentUser.name,
          location: currentUser.location,
          online_at: new Date().toISOString(),
        });
      }
    });
}

// ============ 群组同步 ============
async function initGroupsRealtime() {
  const { data: groups, error } = await supabaseClient.from('groups').select('*').order('created_at', { ascending: true });
  if (!error && groups) renderGroups(groups);

  supabaseClient.channel('groups-channel')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'groups' }, () => {
      supabaseClient.from('groups').select('*').order('created_at', { ascending: true }).then(({ data }) => {
        if (data) renderGroups(data);
      });
    })
    .subscribe();
}

// ============ 渲染群聊列表 ============
function renderGroups(groups) {
  const list = document.getElementById('chatList');
  list.innerHTML = groups.map(g => `
    <div class="list-item ${g.id === currentGroup ? 'active' : ''}" data-id="${g.id}" data-name="${escapeHtml(g.name)}">
      <div class="item-avatar">${escapeHtml(g.name.charAt(0))}</div>
      <div class="item-info">
        <div class="item-title">${escapeHtml(g.name)}</div>
        <div class="item-desc">点击进入聊天</div>
      </div>
    </div>
  `).join('');
  
  list.querySelectorAll('.list-item').forEach(el => {
    el.addEventListener('click', () => selectGroup(el.dataset.id, el.dataset.name));
  });
}

// ============ 选择并加载群聊 ============
async function selectGroup(groupId, groupName) {
  currentGroup = groupId;
  document.getElementById('emptyState').classList.add('hidden');
  document.getElementById('chatSession').classList.remove('hidden');
  document.getElementById('currentGroupName').textContent = groupName;
  
  document.querySelectorAll('#chatList .list-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === groupId);
  });

  const { data: messages } = await supabaseClient
    .from('messages')
    .select('*')
    .eq('group_id', groupId)
    .order('created_at', { ascending: true })
    .limit(100);
  
  if (messages) renderMessages(messages);

  supabaseClient.channel(`messages-${groupId}`)
    .on('postgres_changes', 
      { event: 'INSERT', schema: 'public', table: 'messages', filter: `group_id=eq.${groupId}` }, 
      (payload) => appendMessage(payload.new)
    )
    .subscribe();
}

// ============ 渲染通讯录（在线用户） ============
function renderContacts(onlineUsers) {
  const list = document.getElementById('contactList');
  if (!onlineUsers || onlineUsers.length === 0) {
    list.innerHTML = '<div style="padding:20px;text-align:center;color:#999;">暂无人在线</div>';
    return;
  }
  const uniqueUsers = Array.from(new Map(onlineUsers.map(u => [u.name, u])).values());
  list.innerHTML = uniqueUsers.map(u => `
    <div class="list-item">
      <div class="item-avatar" style="background:${u.name === currentUser.name ? '#07c160' : '#4a90d9'}">
        ${escapeHtml(u.name.charAt(0).toUpperCase())}
      </div>
      <div class="item-info">
        <div class="item-title">${escapeHtml(u.name)} ${u.name === currentUser.name ? '(我)' : ''}</div>
        <div class="item-desc">📍 ${escapeHtml(u.location || '未知')}</div>
      </div>
    </div>
  `).join('');
}

// ============ 渲染消息 ============
function renderMessages(messages) {
  const container = document.getElementById('messageList');
  container.innerHTML = '';
  messages.forEach(msg => appendMessage(msg));
}

function appendMessage(msg) {
  const container = document.getElementById('messageList');
  const isSelf = msg.sender_name === currentUser.name;
  
  const div = document.createElement('div');
  div.className = `message-row ${isSelf ? 'self' : ''}`;
  div.innerHTML = `
    <div class="avatar">${escapeHtml(msg.sender_name.charAt(0).toUpperCase())}</div>
    <div class="bubble-wrap">
      <div class="sender-info">${escapeHtml(msg.sender_name)} · ${escapeHtml(msg.location || '')}</div>
      <div class="bubble">${escapeHtml(msg.content)}</div>
      <div class="time-tag">${formatTime(new Date(msg.created_at).getTime())}</div>
    </div>
  `;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

// ============ 发送消息 ============
async function sendMessage() {
  const input = document.getElementById('messageInput');
  const text = input.value.trim();
  if (!text || !currentGroup) return;

  const { error } = await supabaseClient.from('messages').insert({
    group_id: currentGroup,
    sender_name: currentUser.name,
    location: currentUser.location,
    content: text
  });

  if (error) return alert('发送失败：' + error.message);
  input.value = '';
}

document.getElementById('sendBtn').addEventListener('click', sendMessage);
document.getElementById('messageInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendMessage(); });

// ============ 标签切换 ============
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentTab = tab.dataset.tab;
    document.getElementById('chatList').classList.toggle('hidden', currentTab !== 'chats');
    document.getElementById('contactList').classList.toggle('hidden', currentTab !== 'contacts');
  });
});

// ============ 创建新群聊 ============
document.getElementById('addBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('addMenu').classList.toggle('hidden');
});
document.addEventListener('click', () => document.getElementById('addMenu').classList.add('hidden'));
document.getElementById('addMenu').addEventListener('click', e => e.stopPropagation());

document.getElementById('menuNewGroup').addEventListener('click', () => {
  document.getElementById('newGroupModal').classList.remove('hidden');
});
document.getElementById('cancelNewGroup').addEventListener('click', () => {
  document.getElementById('newGroupModal').classList.add('hidden');
});

document.getElementById('confirmNewGroup').addEventListener('click', async () => {
  const name = document.getElementById('newGroupNameInput').value.trim();
  if (!name) return alert('请输入群聊名称');

  const { error } = await supabaseClient.from('groups').insert({ name });
  
  if (error) alert('创建群聊失败：' + error.message);
  else {
    document.getElementById('newGroupModal').classList.add('hidden');
    document.getElementById('newGroupNameInput').value = '';
  }
});

// ============ 退出登录 ============
document.getElementById('logoutBtn').addEventListener('click', async () => {
  if (presenceChannel) await presenceChannel.untrack();
  localStorage.removeItem('chat_user');
  location.reload();
});
