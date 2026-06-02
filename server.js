const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const META_FILE = path.join(UPLOAD_DIR, '_meta.json');

// 确保上传目录存在
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// 元数据（记录上传者信息）
function loadMeta() {
  if (!fs.existsSync(META_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(META_FILE, 'utf8')); }
  catch { return {}; }
}
function saveMeta(meta) {
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), 'utf8');
}

// 尝试从 IP 反查电脑主机名
const dns = require('dns');
function resolveHostname(ip) {
  return new Promise(resolve => {
    dns.reverse(ip, (err, hostnames) => {
      if (err || !hostnames || hostnames.length === 0) resolve(ip);
      else resolve(hostnames[0]);
    });
  });
}

// 文件存储配置
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // 支持文件夹上传：保持原始文件夹结构
    let dir = UPLOAD_DIR;
    if (file.originalname.includes('/') || file.originalname.includes('\\')) {
      // webkitRelativePath 或文件夹上传，保持路径结构
      const relativePath = file.originalname.replace(/\\/g, '/');
      dir = path.join(UPLOAD_DIR, path.dirname(relativePath));
    }
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const rawName = file.originalname;
    // 提取纯文件名
    const fileName = rawName.includes('/') ? rawName.split('/').pop() : rawName.includes('\\') ? rawName.split('\\').pop() : rawName;
    const originalName = Buffer.from(fileName, 'latin1').toString('utf8');
    const fullPath = path.join(req.body._uploadDir || UPLOAD_DIR, originalName);
    if (fs.existsSync(fullPath)) {
      const ext = path.extname(originalName);
      const base = path.basename(originalName, ext);
      cb(null, `${base}_${Date.now()}${ext}`);
    } else {
      cb(null, originalName);
    }
  }
});

const upload = multer({
  storage,
  limits: { fileSize: Infinity } // 不限制大小
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json()); // 全局 JSON body 解析

// API: 删除文件（放在最前面，确保路由优先匹配）
app.post('/api/delete', (req, res) => {
  let relPath = req.query.name || '';
  if (!relPath) return res.status(400).json({ error: '缺少文件名' });
  const filePath = path.join(UPLOAD_DIR, relPath);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: '文件不存在' });
  }
  try { fs.unlinkSync(filePath); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// 递归获取文件夹下所有文件
function scanFiles(dir, basePath = '') {
  const result = [];
  const items = fs.readdirSync(dir);
  for (const item of items) {
    const fullPath = path.join(dir, item);
    const relativePath = basePath ? `${basePath}/${item}` : item;
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      result.push(...scanFiles(fullPath, relativePath));
    } else {
      result.push({
        name: relativePath,
        size: stat.size,
        sizeStr: formatSize(stat.size),
        time: stat.mtime.toISOString()
      });
    }
  }
  return result;
}

// API: 获取文件列表
app.get('/api/files', (req, res) => {
  try {
    if (!fs.existsSync(UPLOAD_DIR)) return res.json([]);
    const fileList = scanFiles(UPLOAD_DIR);
    const meta = loadMeta();
    fileList.forEach(f => {
      if (meta[f.name]) {
        f.computerId = meta[f.name].computerId;
      }
    });
    fileList.sort((a, b) => new Date(b.time) - new Date(a.time));
    res.json(fileList);
  } catch(e) {
    res.json([]);
  }
});

// API: 上传文件
app.post('/api/upload', upload.array('files', 20), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: '没有选择文件' });
  }
  const ip = req.ip || req.connection.remoteAddress;
  const hostname = await resolveHostname(ip);
  const computerId = hostname !== ip ? hostname : `电脑 (${ip})`;

  const meta = loadMeta();
  const uploaded = req.files.map(f => {
    const name = Buffer.from(f.originalname, 'latin1').toString('utf8');
    meta[name] = {
      computerId,
      ip,
      time: new Date().toISOString()
    };
    return { name, size: f.size, sizeStr: formatSize(f.size) };
  });
  saveMeta(meta);

  res.json({ success: true, files: uploaded });
});

// API: 下载文件（支持子文件夹路径，用 middleware 匹配）
app.use('/api/download', (req, res) => {
  const relPath = decodeURIComponent(req.path.replace(/^\//, ''));
  const filePath = path.join(UPLOAD_DIR, relPath);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('文件不存在');
  }
  const fileName = path.basename(filePath);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  res.sendFile(filePath);
});

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ====== 任务管理系统 ======
const TASK_FILE = path.join(__dirname, 'tasks.json');

function loadTasks() {
  if (!fs.existsSync(TASK_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(TASK_FILE, 'utf8')); }
  catch { return []; }
}
function saveTasks(tasks) {
  fs.writeFileSync(TASK_FILE, JSON.stringify(tasks, null, 2), 'utf8');
}

// 获取所有任务
app.get('/api/tasks', (req, res) => {
  const tasks = loadTasks();
  // 排序：紧急在前
  const urgencyOrder = { '紧急': 0, '普通': 1, '不急': 2 };
  tasks.sort((a, b) => (urgencyOrder[a.urgency] || 9) - (urgencyOrder[b.urgency] || 9));
  res.json(tasks);
});

// 添加任务
app.post('/api/tasks', (req, res) => {
  const tasks = loadTasks();
  const { title, assignee, urgency, requester, progress } = req.body;
  const task = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: title || '新任务',
    assignee: assignee || '王婷婷',
    progress: progress || 0,
    urgency: urgency || '普通',
    requester: requester || '未知部门',
    status: (progress >= 100) ? 'completed' : 'active',
    createdAt: new Date().toISOString()
  };
  tasks.push(task);
  saveTasks(tasks);
  res.json(task);
});

// 更新任务进度
app.put('/api/tasks/:id', express.json(), (req, res) => {
  const tasks = loadTasks();
  const idx = tasks.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '任务不存在' });
  if (req.body.progress !== undefined) {
    tasks[idx].progress = req.body.progress;
    tasks[idx].status = req.body.progress >= 100 ? 'completed' : 'active';
  }
  if (req.body.title) tasks[idx].title = req.body.title;
  if (req.body.assignee) tasks[idx].assignee = req.body.assignee;
  if (req.body.urgency) tasks[idx].urgency = req.body.urgency;
  if (req.body.status) tasks[idx].status = req.body.status; // 手动恢复用
  saveTasks(tasks);
  res.json(tasks[idx]);
});

// 删除任务
app.delete('/api/tasks/:id', (req, res) => {
  let tasks = loadTasks();
  tasks = tasks.filter(t => t.id !== req.params.id);
  saveTasks(tasks);
  res.json({ success: true });
});

// ====== 需求池 ======
const REQUEST_FILE = path.join(__dirname, 'requests.json');

function loadRequests() {
  if (!fs.existsSync(REQUEST_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(REQUEST_FILE, 'utf8')); }
  catch { return []; }
}
function saveRequests(requests) {
  fs.writeFileSync(REQUEST_FILE, JSON.stringify(requests, null, 2), 'utf8');
}

// 获取需求池
app.get('/api/requests', (req, res) => {
  const requests = loadRequests();
  const urgencyOrder = { '紧急': 0, '普通': 1, '不急': 2 };
  requests.sort((a, b) => (urgencyOrder[a.urgency] || 9) - (urgencyOrder[b.urgency] || 9));
  res.json(requests);
});

// 提交需求（支持附件上传）
const REQUEST_UPLOAD_DIR = path.join(__dirname, 'request-attachments');
if (!fs.existsSync(REQUEST_UPLOAD_DIR)) fs.mkdirSync(REQUEST_UPLOAD_DIR, { recursive: true });

const requestUpload = multer({
  storage: multer.diskStorage({
    destination: REQUEST_UPLOAD_DIR,
    filename: (req, file, cb) => {
      const name = Buffer.from(file.originalname, 'latin1').toString('utf8');
      cb(null, Date.now() + '_' + name);
    }
  }),
  limits: { fileSize: Infinity }
});

app.post('/api/requests', requestUpload.array('attachments', 10), (req, res) => {
  const { title, urgency, requester, description, deadline } = req.body;
  if (!title || !urgency || !requester) {
    return res.status(400).json({ error: '标题、紧急程度、需求部门均为必填' });
  }
  const attachments = (req.files || []).map(f => ({
    name: Buffer.from(f.originalname, 'latin1').toString('utf8'),
    path: f.filename,
    size: f.size,
    sizeStr: formatSize(f.size)
  }));
  const requests = loadRequests();
  requests.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title, urgency, requester,
    description: description || '',
    deadline: deadline || '',
    attachments,
    status: 'pending',
    createdAt: new Date().toISOString()
  });
  saveRequests(requests);
  res.json({ success: true });
});

// 下载需求附件
app.get('/api/requests/attachment/:filename', (req, res) => {
  const fp = path.join(REQUEST_UPLOAD_DIR, req.params.filename);
  if (!fs.existsSync(fp)) return res.status(404).send('文件不存在');
  res.download(fp);
});

// 接单/拒绝
app.post('/api/requests/:id/action', (req, res) => {
  const { action, assignee } = req.body; // action: 'accept' | 'reject'
  const requests = loadRequests();
  const idx = requests.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '需求不存在' });

  if (action === 'accept') {
    const r = requests[idx];
    // 允许重新接单（包括已拒绝的）
    if (r.status === 'accepted') return res.json({ success: true, request: r });
    r.status = 'accepted';
    r.acceptedBy = assignee;
    r.acceptedAt = new Date().toISOString();
    saveRequests(requests);
    // 检查是否已经转成过任务，避免重复
    const tasks = loadTasks();
    if (!tasks.find(t => t.id === r.id)) {
      tasks.push({
        id: r.id, title: r.title, assignee, progress: 0,
        urgency: r.urgency, requester: r.requester,
        description: r.description || '',
        deadline: r.deadline || '',
        attachments: r.attachments || [],
        createdAt: new Date().toISOString()
      });
      saveTasks(tasks);
    }
  } else if (action === 'reject') {
    requests[idx].status = 'rejected';
    requests[idx].rejectedBy = assignee;
    requests[idx].rejectedAt = new Date().toISOString();
    saveRequests(requests);
  }
  res.json({ success: true, request: requests[idx] });
});

// 删除需求（仅市场部成员）
app.delete('/api/requests/:id', (req, res) => {
  let requests = loadRequests();
  requests = requests.filter(r => r.id !== req.params.id);
  saveRequests(requests);
  res.json({ success: true });
});

// ====== 密码验证 ======
const PASSWORD_FILE = path.join(__dirname, 'passwords.json');
// 默认密码，首次启动自动创建
const DEFAULT_PASSWORDS = {
  '王婷婷': '1111',
  '张影': '2222',
  '吴丙过': '3333',
  '刘玉斐': '4444'
};
function loadPasswords() {
  if (!fs.existsSync(PASSWORD_FILE)) {
    fs.writeFileSync(PASSWORD_FILE, JSON.stringify(DEFAULT_PASSWORDS, null, 2), 'utf8');
    return DEFAULT_PASSWORDS;
  }
  try { return JSON.parse(fs.readFileSync(PASSWORD_FILE, 'utf8')); }
  catch { return DEFAULT_PASSWORDS; }
}

app.post('/api/login', (req, res) => {
  const { name, password } = req.body;
  const passwords = loadPasswords();
  if (passwords[name] && passwords[name] === password) {
    res.json({ success: true, token: name + '_' + Date.now().toString(36) });
  } else {
    res.status(401).json({ error: '密码错误' });
  }
});

// 获取公网隧道地址（serveo优先）
app.get('/api/public-url', (req, res) => {
  // 先查serveo
  const serveoLog = path.join(__dirname, '..', 'serveo.log');
  if (fs.existsSync(serveoLog)) {
    const log = fs.readFileSync(serveoLog, 'utf8');
    const match = log.match(/https:\/\/[a-zA-Z0-9.-]*\.serveousercontent\.com/g);
    if (match) return res.json({ url: match[match.length - 1] });
  }
  // 备选cloudflared
  const tunnelLog = path.join(__dirname, '..', 'tunnel.log');
  if (fs.existsSync(tunnelLog)) {
    const log = fs.readFileSync(tunnelLog, 'utf8');
    const match = log.match(/https:\/\/[a-zA-Z0-9.-]*\.trycloudflare\.com/g);
    if (match) return res.json({ url: match[match.length - 1] });
  }
  res.json({ url: '暂无' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`文件共享空间已启动: http://localhost:${PORT}`);
  // 显示局域网地址
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`局域网地址: http://${net.address}:${PORT}`);
      }
    }
  }
  console.log(`文件存储: ${UPLOAD_DIR}`);
  // 自动启动serveo隧道（守护模式，断了自连）
  const { spawn } = require('child_process');
  function startTunnel() {
    const ssh = spawn('ssh', [
      '-i', require('os').homedir() + '/.ssh/id_rsa',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ServerAliveInterval=15',
      '-o', 'TCPKeepAlive=yes',
      '-R', 'wubing-task:80:localhost:' + PORT,
      'serveo.net'
    ], { detached: true, stdio: 'ignore' });
    ssh.on('close', () => { setTimeout(startTunnel, 3000); });
    ssh.unref();
  }
  setTimeout(startTunnel, 2000);
});
