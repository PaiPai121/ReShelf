// Side Panel 主逻辑
let scanResults = {
  broken: [],
  duplicates: [],
  suggestions: []
};

let validBookmarks = []; // 存活的书签（用于 AI 分类）
let aiClassificationResult = null; // AI 分类结果

// DOM 元素
const scanBtn = document.getElementById('scanBtn');
const classifyBtn = document.getElementById('classifyBtn');
const restructureBtn = document.getElementById('restructureBtn');
const brokenList = document.getElementById('brokenList');
const duplicateList = document.getElementById('duplicateList');
const suggestionList = document.getElementById('suggestionList');
const stats = document.getElementById('stats');
const brokenCount = document.getElementById('brokenCount');
const duplicateCount = document.getElementById('duplicateCount');
const suggestionCount = document.getElementById('suggestionCount');

// API 设置相关元素
const toggleApiSettings = document.getElementById('toggleApiSettings');
const apiSettingsContent = document.getElementById('apiSettingsContent');
const apiProvider = document.getElementById('apiProvider');
const apiKey = document.getElementById('apiKey');
const apiBaseUrl = document.getElementById('apiBaseUrl');
const saveApiSettings = document.getElementById('saveApiSettings');
const apiStatus = document.getElementById('apiStatus');

// AI 预览相关元素
const aiPreviewSection = document.getElementById('aiPreviewSection');
const folderTree = document.getElementById('folderTree');
const confirmOrganizeBtn = document.getElementById('confirmOrganizeBtn');
const cancelOrganizeBtn = document.getElementById('cancelOrganizeBtn');

// 删除重复按钮
const removeDuplicatesBtn = document.getElementById('removeDuplicatesBtn');

// 导出和清理按钮
const exportBackupBtn = document.getElementById('exportBackupBtn');
const cleanAllBrokenBtn = document.getElementById('cleanAllBrokenBtn');
const cleanAllDuplicatesBtn = document.getElementById('cleanAllDuplicatesBtn');

// 初始化
document.addEventListener('DOMContentLoaded', async () => {
  // 加载保存的 API 设置
  await loadApiSettings();

  // 监听来自 background 的消息
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[sidepanel] 收到消息:', message.type, message);
    if (message.type === 'scanProgress') {
      updateProgress(message.data);
    } else if (message.type === 'scanComplete') {
      handleScanComplete(message.data);
    } else if (message.type === 'classifyProgress') {
      updateClassifyProgress(message.data);
    } else if (message.type === 'classifyComplete') {
      console.log('[sidepanel] 收到 classifyComplete 消息，数据:', message.data);
      handleClassifyComplete(message.data);
    }
  });

  // 扫描按钮点击事件
  scanBtn.addEventListener('click', startScan);

  // AI 分类按钮点击事件
  classifyBtn.addEventListener('click', startAIClassification);

  // 重构按钮点击事件
  restructureBtn.addEventListener('click', restructureBookmarks);

  // API 设置相关事件
  toggleApiSettings.addEventListener('click', () => {
    const isVisible = apiSettingsContent.style.display !== 'none';
    apiSettingsContent.style.display = isVisible ? 'none' : 'block';
    toggleApiSettings.textContent = isVisible ? '▼' : '▲';
  });

  saveApiSettings.addEventListener('click', saveApiSettingsHandler);

  // 测试连接按钮
  const testApiConnection = document.getElementById('testApiConnection');
  testApiConnection.addEventListener('click', testApiConnectionHandler);

  // AI 预览相关事件
  confirmOrganizeBtn.addEventListener('click', confirmOrganize);
  cancelOrganizeBtn.addEventListener('click', cancelOrganize);

  // 删除重复按钮事件
  removeDuplicatesBtn.addEventListener('click', removeDuplicates);

  // 导出备份按钮事件
  exportBackupBtn.addEventListener('click', exportBookmarks);

  // 清理按钮事件
  cleanAllBrokenBtn.addEventListener('click', cleanAllBroken);
  cleanAllDuplicatesBtn.addEventListener('click', cleanAllDuplicates);
});

// 开始扫描
async function startScan() {
  scanBtn.disabled = true;
  scanBtn.textContent = '扫描中...';
  
  // 显示加载状态
  showLoading();
  
  // 发送扫描请求到 background
  chrome.runtime.sendMessage({ type: 'startScan' }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('Error:', chrome.runtime.lastError);
      showError('扫描失败，请重试');
      resetScanButton();
    }
  });
}

// 更新扫描进度
function updateProgress(data) {
  // 可以在这里显示进度信息
  // console.log('Scan progress:', data); // 减少日志输出
}

// 处理扫描完成
function handleScanComplete(data) {
  scanResults = data;
  
  // 计算存活的书签（排除失效和重复的）
  const brokenIds = new Set(data.broken.map(b => b.id));
  const duplicateIds = new Set();
  data.duplicates.forEach(group => {
    // 保留第一个，标记其余为重复
    for (let i = 1; i < group.length; i++) {
      duplicateIds.add(group[i].id);
    }
  });
  
  // 获取所有书签，过滤出存活的
  chrome.bookmarks.getTree((tree) => {
    const allBookmarks = flattenBookmarkTree(tree);
    validBookmarks = allBookmarks.filter(b => 
      b.url && 
      !brokenIds.has(b.id) && 
      !duplicateIds.has(b.id)
    );
    
    // 如果有存活的书签，显示 AI 分类按钮
    if (validBookmarks.length > 0) {
      classifyBtn.style.display = 'block';
    }
  });
  
  // 更新列表
  updateBrokenList(data.broken);
  updateDuplicateList(data.duplicates);
  updateSuggestionList(data.suggestions);
  
  // 更新统计（注意：不要覆盖已有的 AI 分类结果）
  updateStats();
  
  // 启用重构按钮
  if (data.broken.length > 0 || data.duplicates.length > 0 || data.suggestions.length > 0) {
    restructureBtn.disabled = false;
  }
  
  resetScanButton();
}

// 扁平化书签树（用于获取所有书签）
function flattenBookmarkTree(tree) {
  const result = [];
  
  function traverse(nodes) {
    for (const node of nodes) {
      if (node.url) {
        result.push({
          id: node.id,
          title: node.title,
          url: node.url,
          parentId: node.parentId
        });
      }
      if (node.children) {
        traverse(node.children);
      }
    }
  }
  
  traverse(tree);
  return result;
}

// 更新统计信息
function updateStats() {
  brokenCount.textContent = scanResults.broken.length;
  duplicateCount.textContent = scanResults.duplicates.length;
  
  // 建议分类数量：如果有 AI 分类结果，显示分类数量；否则显示0
  console.log('[updateStats] ========== 更新统计信息 ==========');
  console.log('[updateStats] aiClassificationResult:', aiClassificationResult);
  
  const suggestionHint = document.getElementById('suggestionHintText');
  
  if (aiClassificationResult && aiClassificationResult.folders && Array.isArray(aiClassificationResult.folders)) {
    const totalSuggestions = aiClassificationResult.folders.reduce((sum, folder) => {
      const count = folder.bookmarks ? folder.bookmarks.length : 0;
      console.log('[updateStats] 文件夹:', folder.folder, '书签数:', count);
      return sum + count;
    }, 0);
    console.log('[updateStats] 总建议分类数:', totalSuggestions);
    suggestionCount.textContent = totalSuggestions;
    console.log('[updateStats] suggestionCount 元素已更新为:', totalSuggestions);
    
    // 更新提示文字
    if (suggestionHint) {
      suggestionHint.textContent = `${totalSuggestions} 个书签已分类`;
    }
  } else {
    console.log('[updateStats] 无 AI 分类结果，显示 0');
    suggestionCount.textContent = '0';
    
    // 更新提示文字
    if (suggestionHint) {
      suggestionHint.textContent = '点击"AI 智能分类"按钮生成';
    }
  }
  
  stats.style.display = 'grid';
  console.log('[updateStats] ========== 统计信息更新完成 ==========');
  
  // 显示/隐藏清理按钮
  if (scanResults.broken.length > 0) {
    cleanAllBrokenBtn.style.display = 'block';
  } else {
    cleanAllBrokenBtn.style.display = 'none';
  }
  
  if (scanResults.duplicates.length > 0) {
    cleanAllDuplicatesBtn.style.display = 'block';
  } else {
    cleanAllDuplicatesBtn.style.display = 'none';
  }
}

// 更新失效链接列表
function updateBrokenList(broken) {
  brokenList.innerHTML = '';
  
  if (broken.length === 0) {
    brokenList.innerHTML = `
      <li class="empty-state">
        <div class="empty-state-icon">✅</div>
        <div>没有发现失效链接</div>
      </li>
    `;
    return;
  }
  
  broken.forEach(item => {
    const li = document.createElement('li');
    li.className = 'list-item';
    li.innerHTML = `
      <div class="list-item-title">${escapeHtml(item.title)}</div>
      <div class="list-item-url">${escapeHtml(item.url)}</div>
      <span class="badge badge-error">失效</span>
    `;
    brokenList.appendChild(li);
  });
}

// 更新重复项列表
function updateDuplicateList(duplicates) {
  duplicateList.innerHTML = '';
  
  if (duplicates.length === 0) {
    removeDuplicatesBtn.style.display = 'none';
    duplicateList.innerHTML = `
      <li class="empty-state">
        <div class="empty-state-icon">✅</div>
        <div>没有发现重复项</div>
      </li>
    `;
    return;
  }
  
  // 显示删除按钮
  removeDuplicatesBtn.style.display = 'block';
  
  duplicates.forEach(group => {
    group.forEach((item, index) => {
      const li = document.createElement('li');
      li.className = 'list-item';
      li.innerHTML = `
        <div class="list-item-title">${escapeHtml(item.title)}</div>
        <div class="list-item-url">${escapeHtml(item.url)}</div>
        <span class="badge badge-warning">重复 ${index + 1}/${group.length}</span>
      `;
      duplicateList.appendChild(li);
    });
  });
}

// 删除重复项
async function removeDuplicates() {
  if (scanResults.duplicates.length === 0) {
    return;
  }
  
  // 计算要删除的书签数量（每组保留第一个）
  let totalToRemove = 0;
  scanResults.duplicates.forEach(group => {
    totalToRemove += group.length - 1;
  });
  
  if (!confirm(`确定要删除 ${totalToRemove} 个重复书签吗？每组将保留第一个。`)) {
    return;
  }
  
  removeDuplicatesBtn.disabled = true;
  removeDuplicatesBtn.textContent = '删除中...';
  
  chrome.runtime.sendMessage({
    type: 'removeDuplicates',
    data: scanResults.duplicates
  }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('Error:', chrome.runtime.lastError);
      alert('删除失败，请重试');
    } else if (response.error) {
      alert(`删除失败：${response.error}`);
    } else {
      alert(`成功删除 ${totalToRemove} 个重复书签！`);
      // 重新扫描
      startScan();
    }
    removeDuplicatesBtn.disabled = false;
    removeDuplicatesBtn.textContent = '🗑️ 一键删除重复';
  });
}

// 更新建议分类列表
function updateSuggestionList(suggestions) {
  suggestionList.innerHTML = '';
  
  if (suggestions.length === 0) {
    suggestionList.innerHTML = `
      <li class="empty-state">
        <div class="empty-state-icon">✨</div>
        <div>暂无分类建议</div>
      </li>
    `;
    return;
  }
  
  suggestions.forEach(item => {
    const li = document.createElement('li');
    li.className = 'list-item';
    li.innerHTML = `
      <div class="list-item-title">${escapeHtml(item.title)}</div>
      <div class="list-item-url">${escapeHtml(item.url)}</div>
      <span class="badge badge-info">建议: ${escapeHtml(item.suggestedCategory)}</span>
    `;
    suggestionList.appendChild(li);
  });
}

// 显示加载状态
function showLoading() {
  brokenList.innerHTML = `
    <li class="loading">
      <div class="spinner"></div>
      <div>正在检测失效链接...</div>
    </li>
  `;
  duplicateList.innerHTML = `
    <li class="loading">
      <div class="spinner"></div>
      <div>正在查找重复项...</div>
    </li>
  `;
  suggestionList.innerHTML = `
    <li class="loading">
      <div class="spinner"></div>
      <div>正在分析分类建议...</div>
    </li>
  `;
}

// 显示错误
function showError(message) {
  brokenList.innerHTML = `
    <li class="empty-state">
      <div class="empty-state-icon">❌</div>
      <div>${escapeHtml(message)}</div>
    </li>
  `;
}

// 重置扫描按钮
function resetScanButton() {
  scanBtn.disabled = false;
  scanBtn.textContent = '🔍 扫描书签';
}

// 重构书签
async function restructureBookmarks() {
  if (!confirm('确定要执行重构吗？这将删除失效链接和重复项，并应用分类建议。')) {
    return;
  }
  
  restructureBtn.disabled = true;
  restructureBtn.textContent = '重构中...';
  
  chrome.runtime.sendMessage({ 
    type: 'restructure',
    data: scanResults 
  }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('Error:', chrome.runtime.lastError);
      alert('重构失败，请重试');
    } else {
      alert('重构完成！');
      // 重新扫描以更新结果
      startScan();
    }
    restructureBtn.disabled = false;
    restructureBtn.textContent = '🚀 一键重构书签';
  });
}

// API 设置相关函数
async function loadApiSettings() {
  const result = await chrome.storage.local.get(['apiProvider', 'apiKey', 'apiBaseUrl']);
  if (result.apiProvider) {
    apiProvider.value = result.apiProvider;
  }
  if (result.apiKey) {
    apiKey.value = result.apiKey;
  }
  if (result.apiBaseUrl) {
    apiBaseUrl.value = result.apiBaseUrl;
  }
}

async function saveApiSettingsHandler() {
  const provider = apiProvider.value;
  const key = apiKey.value.trim();
  const baseUrl = apiBaseUrl.value.trim();
  
  if (!key) {
    showApiStatus('请输入 API Key', 'error');
    return;
  }
  
  await chrome.storage.local.set({
    apiProvider: provider,
    apiKey: key,
    apiBaseUrl: baseUrl
  });
  
  showApiStatus('设置已保存', 'success');
  setTimeout(() => {
    apiStatus.style.display = 'none';
  }, 2000);
}

function showApiStatus(message, type) {
  apiStatus.textContent = message;
  apiStatus.className = `api-status ${type}`;
  apiStatus.style.display = 'block';
  
  // 如果是成功或错误，3秒后自动隐藏
  if (type === 'success' || type === 'error') {
    setTimeout(() => {
      apiStatus.style.display = 'none';
    }, 3000);
  }
}

// 测试 API 连接
async function testApiConnectionHandler() {
  const provider = apiProvider.value;
  const key = apiKey.value.trim();
  const baseUrl = apiBaseUrl.value.trim();
  
  if (!key) {
    showApiStatus('请先输入 API Key', 'error');
    return;
  }
  
  testApiConnection.disabled = true;
  testApiConnection.textContent = '测试中...';
  showApiStatus('正在测试连接...', 'info');
  
  chrome.runtime.sendMessage({
    type: 'testApiConnection',
    data: {
      apiProvider: provider,
      apiKey: key,
      apiBaseUrl: baseUrl
    }
  }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('Error:', chrome.runtime.lastError);
      showApiStatus('测试失败：' + chrome.runtime.lastError.message, 'error');
    } else if (response.error) {
      showApiStatus('测试失败：' + response.error, 'error');
    } else {
      showApiStatus('✅ 连接成功！API 配置正确', 'success');
    }
    testApiConnection.disabled = false;
    testApiConnection.textContent = '🔌 测试连接';
  });
}

// AI 分类相关函数
async function startAIClassification() {
  // 检查 API 设置
  const result = await chrome.storage.local.get(['apiProvider', 'apiKey']);
  if (!result.apiKey) {
    alert('请先配置 API Key');
    apiSettingsContent.style.display = 'block';
    toggleApiSettings.textContent = '▲';
    return;
  }
  
  // 空数据检查
  if (!validBookmarks || validBookmarks.length === 0) {
    alert('没有可供 AI 分类的有效书签。请先扫描书签，确保有存活的、非重复的书签。');
    return;
  }
  
  console.log('[startAIClassification] 开始分类，有效书签数:', validBookmarks.length);
  
  classifyBtn.disabled = true;
  classifyBtn.textContent = 'AI 分析中...';
  
  // 显示加载状态
  folderTree.innerHTML = `
    <div class="loading">
      <div class="spinner"></div>
      <div>AI 正在思考中...</div>
      <div style="font-size: 12px; color: #7f8c8d; margin-top: 8px;">正在使用 AI 分析 ${validBookmarks.length} 个书签并生成分类建议...</div>
    </div>
  `;
  aiPreviewSection.style.display = 'block';
  
  // 发送分类请求到 background
  chrome.runtime.sendMessage({
    type: 'classifyBookmarks',
    data: {
      bookmarks: validBookmarks,
      apiProvider: result.apiProvider || 'gemini',
      apiKey: result.apiKey,
      apiBaseUrl: result.apiBaseUrl || ''
    }
  }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('Error:', chrome.runtime.lastError);
      folderTree.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">❌</div>
          <div>分类失败：${chrome.runtime.lastError.message}</div>
        </div>
      `;
      resetClassifyButton();
    }
  });
}

function updateClassifyProgress(data) {
  console.log('[updateClassifyProgress]', data);
  if (data.message) {
    // 提取批次信息
    const batchMatch = data.message.match(/第 (\d+) 批/);
    const batchInfo = batchMatch ? ` (Batch ${batchMatch[1]})` : '';
    
    folderTree.innerHTML = `
      <div class="loading">
        <div class="spinner"></div>
        <div>AI 正在思考中${batchInfo}...</div>
        <div style="font-size: 12px; color: #7f8c8d; margin-top: 8px;">${data.message}</div>
      </div>
    `;
  }
}

function handleClassifyComplete(data) {
  console.log('[handleClassifyComplete] ========== UI 刷新同步 ==========');
  console.log('[handleClassifyComplete] 接收到的数据:', data);
  aiClassificationResult = data;
  
  if (data.error) {
    console.error('[handleClassifyComplete] 分类错误:', data.error);
    folderTree.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">❌</div>
        <div>${escapeHtml(data.error)}</div>
        <div style="font-size: 12px; color: #95a5a6; margin-top: 8px;">请查看控制台获取详细错误信息</div>
      </div>
    `;
    // 清除分类结果
    aiClassificationResult = null;
    resetClassifyButton();
    // 更新统计（将建议分类设为0）
    updateStats();
    console.log('[handleClassifyComplete] 错误处理完成，统计已更新');
    return;
  }
  
  console.log('[handleClassifyComplete] 分类成功，文件夹数量:', data.folders?.length || 0);
  console.log('[handleClassifyComplete] 文件夹详情:', data.folders);
  
  // 验证数据
  if (!data.folders || !Array.isArray(data.folders) || data.folders.length === 0) {
    console.warn('[handleClassifyComplete] 警告：没有分类结果');
    folderTree.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📁</div>
        <div>AI 未生成分类建议</div>
        <div style="font-size: 12px; color: #95a5a6; margin-top: 8px;">请检查控制台日志查看详细信息</div>
      </div>
    `;
    // 即使没有结果，也保存结果对象（但 folders 为空数组）
    aiClassificationResult = data;
    resetClassifyButton();
    updateStats();
    console.log('[handleClassifyComplete] 空结果处理完成，统计已更新');
    return;
  }
  
  // 显示目录树预览（UI 刷新）
  console.log('[handleClassifyComplete] 调用 displayFolderTree 渲染结果');
  displayFolderTree(data.folders);
  resetClassifyButton();
  
  // 更新统计信息（显示 AI 分类的数量）
  console.log('[handleClassifyComplete] 调用 updateStats 更新统计');
  updateStats();
  
  console.log('[handleClassifyComplete] UI 刷新完成，当前 aiClassificationResult:', aiClassificationResult);
  console.log('[handleClassifyComplete] ========== UI 刷新同步完成 ==========');
}

function displayFolderTree(folders) {
  console.log('[displayFolderTree] 开始渲染目录树，文件夹数量:', folders?.length || 0);
  
  if (!folders || folders.length === 0) {
    console.warn('[displayFolderTree] 文件夹列表为空');
    folderTree.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📁</div>
        <div>AI 未生成分类建议</div>
        <div style="font-size: 12px; color: #95a5a6; margin-top: 8px;">请检查控制台日志查看详细信息</div>
      </div>
    `;
    return;
  }
  
  console.log('[displayFolderTree] 清空 folderTree 元素');
  folderTree.innerHTML = '';
  folderTree.className = 'folder-tree tree-view';
  
  // 获取所有书签的原始路径
  chrome.bookmarks.getTree(async (tree) => {
    const bookmarkPathMap = buildBookmarkPathMap(tree);
    
    folders.forEach(folder => {
      const folderDiv = document.createElement('div');
      folderDiv.className = 'folder-item';
      
      const folderPath = document.createElement('div');
      folderPath.className = 'folder-path';
      folderPath.innerHTML = `📁 <span class="tree-node-path">${escapeHtml(folder.folder)}</span> <span class="tree-node-count">(${folder.bookmarks ? folder.bookmarks.length : 0} 个书签)</span>`;
      folderDiv.appendChild(folderPath);
      
      const bookmarksDiv = document.createElement('div');
      bookmarksDiv.className = 'folder-bookmarks';
      
      if (folder.bookmarks && folder.bookmarks.length > 0) {
        folder.bookmarks.forEach(bookmark => {
          const bookmarkDiv = document.createElement('div');
          bookmarkDiv.className = 'folder-bookmark-item';
          
          // 获取原始路径
          const originalPath = bookmarkPathMap.get(bookmark.id) || '未知位置';
          
          bookmarkDiv.innerHTML = `
            <span class="folder-bookmark-title">${escapeHtml(bookmark.title)}</span>
            <span class="bookmark-move">${escapeHtml(originalPath)} → ${escapeHtml(folder.folder)}</span>
          `;
          bookmarksDiv.appendChild(bookmarkDiv);
        });
      } else {
        bookmarksDiv.textContent = '（无书签）';
      }
      
      folderDiv.appendChild(bookmarksDiv);
      folderTree.appendChild(folderDiv);
    });
  });
}

// 构建书签路径映射
function buildBookmarkPathMap(tree) {
  const pathMap = new Map();
  
  function traverse(nodes, currentPath = '') {
    for (const node of nodes) {
      const nodePath = currentPath ? `${currentPath}/${node.title}` : node.title;
      
      if (node.url) {
        // 这是书签
        pathMap.set(node.id, nodePath);
      }
      
      if (node.children) {
        traverse(node.children, nodePath);
      }
    }
  }
  
  traverse(tree);
  return pathMap;
}

function resetClassifyButton() {
  classifyBtn.disabled = false;
  classifyBtn.textContent = '🤖 AI 智能分类';
}

// 确认整理
async function confirmOrganize() {
  if (!aiClassificationResult || !aiClassificationResult.folders) {
    alert('没有可执行的分类方案');
    return;
  }
  
  if (!confirm('确定要执行整理吗？这将根据 AI 建议创建文件夹并移动书签。')) {
    return;
  }
  
  confirmOrganizeBtn.disabled = true;
  confirmOrganizeBtn.textContent = '整理中...';
  
  chrome.runtime.sendMessage({
    type: 'organizeBookmarks',
    data: aiClassificationResult
  }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('Error:', chrome.runtime.lastError);
      alert('整理失败，请重试');
    } else if (response.error) {
      alert(`整理失败：${response.error}`);
    } else {
      alert('整理完成！');
      // 隐藏预览区域
      aiPreviewSection.style.display = 'none';
      // 重新扫描
      startScan();
    }
    confirmOrganizeBtn.disabled = false;
    confirmOrganizeBtn.textContent = '✅ 确认整理';
  });
}

function cancelOrganize() {
  aiPreviewSection.style.display = 'none';
  aiClassificationResult = null;
}

// 导出备份
async function exportBookmarks() {
  exportBackupBtn.disabled = true;
  exportBackupBtn.textContent = '导出中...';
  
  try {
    chrome.runtime.sendMessage({ type: 'exportBookmarks' }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('Error:', chrome.runtime.lastError);
        alert('导出失败，请重试');
      } else if (response.error) {
        alert(`导出失败：${response.error}`);
      } else {
        // 创建下载链接
        const blob = new Blob([response.html], { type: 'text/html;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = response.filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        alert('备份导出成功！');
      }
      exportBackupBtn.disabled = false;
      exportBackupBtn.textContent = '💾 导出备份';
    });
  } catch (error) {
    console.error('Export error:', error);
    alert('导出失败，请重试');
    exportBackupBtn.disabled = false;
    exportBackupBtn.textContent = '💾 导出备份';
  }
}

// 清理所有失效链接
async function cleanAllBroken() {
  const count = scanResults.broken.length;
  if (count === 0) {
    return;
  }
  
  if (!confirm(`确定要永久删除这 ${count} 个失效链接吗？此操作不可撤销。\n\n建议先导出备份！`)) {
    return;
  }
  
  cleanAllBrokenBtn.disabled = true;
  cleanAllBrokenBtn.textContent = '清理中...';
  
  chrome.runtime.sendMessage({
    type: 'cleanAllBroken',
    data: scanResults.broken
  }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('Error:', chrome.runtime.lastError);
      alert('清理失败，请重试');
    } else if (response.error) {
      alert(`清理失败：${response.error}`);
    } else {
      alert(`成功删除 ${response.removedCount} 个失效链接！`);
      // 更新结果并刷新界面
      scanResults.broken = [];
      updateStats();
      updateBrokenList([]);
    }
    cleanAllBrokenBtn.disabled = false;
    cleanAllBrokenBtn.textContent = '🗑️ 清理所有失效';
  });
}

// 清理所有重复项
async function cleanAllDuplicates() {
  // 计算要删除的数量
  let totalToRemove = 0;
  scanResults.duplicates.forEach(group => {
    totalToRemove += group.length - 1; // 每组保留第一个
  });
  
  if (totalToRemove === 0) {
    return;
  }
  
  if (!confirm(`确定要永久删除这 ${totalToRemove} 个重复书签吗？每组将保留最早添加的那一个。\n\n此操作不可撤销，建议先导出备份！`)) {
    return;
  }
  
  cleanAllDuplicatesBtn.disabled = true;
  cleanAllDuplicatesBtn.textContent = '清理中...';
  
  chrome.runtime.sendMessage({
    type: 'cleanAllDuplicates',
    data: scanResults.duplicates
  }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('Error:', chrome.runtime.lastError);
      alert('清理失败，请重试');
    } else if (response.error) {
      alert(`清理失败：${response.error}`);
    } else {
      alert(`成功删除 ${response.removedCount} 个重复书签！`);
      // 更新结果并刷新界面
      scanResults.duplicates = [];
      updateStats();
      updateDuplicateList([]);
    }
    cleanAllDuplicatesBtn.disabled = false;
    cleanAllDuplicatesBtn.textContent = '🗑️ 清理所有重复';
  });
}

// HTML 转义
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
