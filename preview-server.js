/**
 * preview-server.js
 * 用于在浏览器中直接预览和交互测试「聚客宝·八大电商平台聚合客服工作台」的本地零依赖 HTTP 服务
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);

  let filePath;
  if (urlPath === '/' || urlPath === '/index.html') {
    filePath = path.join(__dirname, 'src/renderer/index.html');
  } else if (urlPath === '/styles.css') {
    filePath = path.join(__dirname, 'src/renderer/styles.css');
  } else if (urlPath === '/app.js') {
    filePath = path.join(__dirname, 'src/renderer/app.js');
  } else if (urlPath === '/platforms.js' || urlPath === '/src/platforms.js') {
    filePath = path.join(__dirname, 'src/platforms.js');
  } else {
    filePath = path.join(__dirname, 'src/renderer', urlPath);
    if (!fs.existsSync(filePath)) {
      filePath = path.join(__dirname, urlPath);
    }
  }

  // 安全路径校验
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(__dirname))) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(resolved, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + urlPath);
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(content);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[聚客宝·聚合客服工作台] 预览服务已启动: http://${HOST}:${PORT}`);
});
