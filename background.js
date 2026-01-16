// Background Service Worker
// 处理书签扫描、死链检测和 AI 分类

// 监听扩展安装
chrome.runtime.onInstalled.addListener(() => {
  console.log('ReShelf extension installed');
});

// 监听来自 side panel 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'startScan') {
    startBookmarkScan().then(results => {
      // 发送结果到 side panel
      chrome.runtime.sendMessage({
        type: 'scanComplete',
        data: results
      }).catch(err => console.error('Error sending scan results:', err));
    });
    sendResponse({ status: 'scanning' });
    return true; // 保持消息通道开放
  }
  
  if (message.type === 'restructure') {
    restructureBookmarks(message.data).then(() => {
      sendResponse({ status: 'success' });
    }).catch(err => {
      console.error('Restructure error:', err);
      sendResponse({ status: 'error', error: err.message });
    });
    return true;
  }
  
  if (message.type === 'classifyBookmarks') {
    classifyBookmarks(message.data).then(result => {
      // 发送结果到 side panel
      chrome.runtime.sendMessage({
        type: 'classifyComplete',
        data: result
      }).catch(err => console.error('Error sending classification results:', err));
    }).catch(err => {
      console.error('Classification error:', err);
      chrome.runtime.sendMessage({
        type: 'classifyComplete',
        data: { error: err.message }
      }).catch(() => {});
    });
    sendResponse({ status: 'classifying' });
    return true;
  }
  
  if (message.type === 'organizeBookmarks') {
    organizeBookmarks(message.data).then(() => {
      sendResponse({ status: 'success' });
    }).catch(err => {
      console.error('Organize error:', err);
      sendResponse({ status: 'error', error: err.message });
    });
    return true;
  }
  
  if (message.type === 'removeDuplicates') {
    removeDuplicates(message.data).then(() => {
      sendResponse({ status: 'success' });
    }).catch(err => {
      console.error('Remove duplicates error:', err);
      sendResponse({ status: 'error', error: err.message });
    });
    return true;
  }
  
  if (message.type === 'exportBookmarks') {
    exportBookmarks().then(result => {
      sendResponse({ status: 'success', html: result.html, filename: result.filename });
    }).catch(err => {
      console.error('Export error:', err);
      sendResponse({ status: 'error', error: err.message });
    });
    return true;
  }
  
  if (message.type === 'cleanAllBroken') {
    cleanAllBroken(message.data).then(result => {
      sendResponse({ status: 'success', removedCount: result.removedCount });
    }).catch(err => {
      console.error('Clean all broken error:', err);
      sendResponse({ status: 'error', error: err.message });
    });
    return true;
  }
  
  if (message.type === 'cleanAllDuplicates') {
    cleanAllDuplicates(message.data).then(result => {
      sendResponse({ status: 'success', removedCount: result.removedCount });
    }).catch(err => {
      console.error('Clean all duplicates error:', err);
      sendResponse({ status: 'error', error: err.message });
    });
    return true;
  }
});

// 开始扫描书签
async function startBookmarkScan() {
  try {
    // 获取所有书签
    const bookmarkTree = await chrome.bookmarks.getTree();
    const allBookmarks = flattenBookmarkTree(bookmarkTree);
    
    // 过滤出 URL 书签（排除文件夹）
    const urlBookmarks = allBookmarks.filter(b => b.url);
    
    console.log(`Found ${urlBookmarks.length} bookmarks to scan`);
    
    // 并行执行检测
    const [broken, duplicates, suggestions] = await Promise.all([
      detectBrokenLinks(urlBookmarks),
      findDuplicates(urlBookmarks),
      classifyWithAI(urlBookmarks)
    ]);
    
    return {
      broken,
      duplicates,
      suggestions
    };
  } catch (error) {
    console.error('Scan error:', error);
    throw error;
  }
}

// 扁平化书签树
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

// 检测失效链接
async function detectBrokenLinks(bookmarks) {
  const broken = [];
  const maxConcurrent = 10; // 最大并发数
  
  // 分批处理，避免过多并发请求
  for (let i = 0; i < bookmarks.length; i += maxConcurrent) {
    const batch = bookmarks.slice(i, i + maxConcurrent);
    const results = await Promise.all(
      batch.map(bookmark => checkLinkStatus(bookmark))
    );
    
    broken.push(...results.filter(r => r !== null));
    
    // 发送进度更新
    chrome.runtime.sendMessage({
      type: 'scanProgress',
      data: {
        phase: 'broken',
        current: Math.min(i + maxConcurrent, bookmarks.length),
        total: bookmarks.length
      }
    }).catch(() => {}); // 忽略错误
  }
  
  return broken;
}

// 检查单个链接状态
async function checkLinkStatus(bookmark) {
  try {
    // 使用 HEAD 请求检测链接
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5秒超时
    
    const response = await fetch(bookmark.url, {
      method: 'HEAD',
      mode: 'no-cors',
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    // 在 no-cors 模式下，无法读取状态码
    // 如果请求没有抛出异常，认为链接有效
    return null;
  } catch (error) {
    // 请求失败，可能是死链
    console.log(`Broken link detected: ${bookmark.title} - ${bookmark.url}`);
    return bookmark;
  }
}

// 查找重复项
function findDuplicates(bookmarks) {
  const urlMap = new Map();
  const duplicates = [];
  
  // 按 URL 分组
  for (const bookmark of bookmarks) {
    const normalizedUrl = normalizeUrl(bookmark.url);
    if (!urlMap.has(normalizedUrl)) {
      urlMap.set(normalizedUrl, []);
    }
    urlMap.get(normalizedUrl).push(bookmark);
  }
  
  // 找出重复的 URL
  for (const [url, items] of urlMap.entries()) {
    if (items.length > 1) {
      duplicates.push(items);
    }
  }
  
  return duplicates;
}

// 标准化 URL（用于重复检测）
function normalizeUrl(url) {
  try {
    const urlObj = new URL(url);
    // 移除末尾斜杠、查询参数和锚点进行比较
    return `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`.replace(/\/$/, '').toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

// AI 分类（预留接口 - 用于旧版扫描）
async function classifyWithAI(bookmarks) {
  // 这个函数保留用于向后兼容，实际分类使用 classifyBookmarks
  return [];
}

// 新的 AI 分类函数（使用滑动窗口）
async function classifyBookmarks(data) {
  const { bookmarks, apiProvider, apiKey, apiBaseUrl } = data;
  const BATCH_SIZE = 20;
  const WINDOW_OVERLAP = 5; // 滑动窗口重叠数量
  const allFolders = [];
  
  try {
    // 发送进度更新
    sendClassifyProgress('开始分析书签...');
    
    // 滑动窗口批处理
    let processedCount = 0;
    let windowStart = 0;
    
    while (windowStart < bookmarks.length) {
      const windowEnd = Math.min(windowStart + BATCH_SIZE, bookmarks.length);
      const batch = bookmarks.slice(windowStart, windowEnd);
      const batchNumber = Math.floor(windowStart / (BATCH_SIZE - WINDOW_OVERLAP)) + 1;
      const estimatedBatches = Math.ceil(bookmarks.length / (BATCH_SIZE - WINDOW_OVERLAP));
      
      sendClassifyProgress(`正在分析第 ${batchNumber} 批书签 (${windowStart + 1}-${windowEnd}/${bookmarks.length})...`);
      
      try {
        // 调用 AI API
        const batchResult = await callAIClassifyAPI(
          batch,
          apiProvider,
          apiKey,
          apiBaseUrl
        );
        
        if (batchResult && batchResult.folders) {
          allFolders.push(...batchResult.folders);
        }
        
        processedCount += batch.length;
        
        // 滑动窗口：下一个窗口的起始位置
        windowStart += (BATCH_SIZE - WINDOW_OVERLAP);
        
        // 频率限制：根据 API 提供商设置不同的延迟
        const delay = apiProvider === 'gemini' ? 1000 : 800; // Gemini 稍慢一些
        if (windowStart < bookmarks.length) {
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      } catch (error) {
        console.error(`批次处理错误 (${windowStart}-${windowEnd}):`, error);
        // 如果单个批次失败，继续处理下一批次
        windowStart += (BATCH_SIZE - WINDOW_OVERLAP);
        // 增加延迟，避免连续失败
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    // 合并相同文件夹的建议
    const mergedFolders = mergeFolderSuggestions(allFolders);
    
    sendClassifyProgress('分类分析完成！');
    
    return {
      folders: mergedFolders,
      totalBookmarks: bookmarks.length,
      processedCount: processedCount
    };
  } catch (error) {
    console.error('Classification error:', error);
    throw error;
  }
}

// 调用 AI API（支持 Gemini 和智谱 AI）
async function callAIClassifyAPI(bookmarks, provider, apiKey, baseUrl) {
  const prompt = buildClassificationPrompt(bookmarks);
  
  if (provider === 'gemini') {
    return await callGeminiAPI(bookmarks, prompt, apiKey, baseUrl);
  } else if (provider === 'zhipu') {
    return await callZhipuAPI(bookmarks, prompt, apiKey, baseUrl);
  } else {
    throw new Error(`不支持的 API 提供商: ${provider}`);
  }
}

// 构建分类提示词（优化版：强调只返回 JSON）
function buildClassificationPrompt(bookmarks) {
  const bookmarksList = bookmarks.map((b, index) => 
    `${index + 1}. 标题: "${b.title}", URL: ${b.url}, ID: ${b.id}`
  ).join('\n');
  
  return `你是资深数字图书管理员。根据书签的标题和URL推断所属领域，建议层级分明的文件夹结构。

要求：
- 分类合理、有意义，便于查找
- 支持多级分类（用 "/" 分隔，如 "编程/算法"、"设计/UI/工具"）
- 每个分类包含相关的书签

书签列表：
${bookmarksList}

重要：只返回合法的 JSON 数组，格式为 [{"folder": "父目录/子目录", "ids": ["id1", "id2"]}]。不要任何开场白、解释或 markdown 代码块标记。`;
}

// 调用 Gemini API
async function callGeminiAPI(bookmarks, prompt, apiKey, baseUrl) {
  // Gemini API 格式: https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={apiKey}
  const model = 'gemini-pro';
  let url;
  
  if (baseUrl && baseUrl.trim()) {
    // 使用自定义 base URL
    url = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    if (!url.includes('models/')) {
      url = `${url}/models/${model}:generateContent`;
    }
    url = `${url}?key=${apiKey}`;
  } else {
    // 使用默认 URL
    url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  }
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      contents: [{
        parts: [{
          text: prompt
        }]
      }]
    })
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API 错误: ${response.status} - ${errorText}`);
  }
  
  const data = await response.json();
  
  // 提取响应文本
  let responseText = '';
  if (data.candidates && data.candidates[0] && data.candidates[0].content) {
    responseText = data.candidates[0].content.parts[0].text;
  }
  
  return parseAIResponse(responseText, bookmarks);
}

// 调用智谱 AI API
async function callZhipuAPI(bookmarks, prompt, apiKey, baseUrl) {
  const apiUrl = baseUrl || 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
  
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'glm-4',
      messages: [
        {
          role: 'system',
          content: '你是一位资深的图书管理员，擅长对数字资源进行科学分类。请只返回 JSON 格式的响应，不要包含其他文字说明。'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.7
    })
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`智谱 AI API 错误: ${response.status} - ${errorText}`);
  }
  
  const data = await response.json();
  
  // 提取响应文本
  let responseText = '';
  if (data.choices && data.choices[0] && data.choices[0].message) {
    responseText = data.choices[0].message.content;
  }
  
  return parseAIResponse(responseText, bookmarks);
}

// 解析 AI 响应（加强错误处理）
function parseAIResponse(responseText, bookmarks) {
  let jsonText = responseText.trim();
  
  // 方法1: 移除 markdown 代码块标记
  jsonText = jsonText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '');
  jsonText = jsonText.trim();
  
  // 方法2: 使用正则提取 JSON 数组
  const jsonArrayMatch = jsonText.match(/\[[\s\S]*\]/);
  if (jsonArrayMatch) {
    jsonText = jsonArrayMatch[0];
  }
  
  // 方法3: 尝试修复常见的 JSON 格式问题
  try {
    // 移除可能的注释
    jsonText = jsonText.replace(/\/\/.*$/gm, '');
    // 移除尾随逗号
    jsonText = jsonText.replace(/,(\s*[}\]])/g, '$1');
    
    // 解析 JSON
    let folders = JSON.parse(jsonText);
    
    if (!Array.isArray(folders)) {
      throw new Error('响应格式错误：期望 JSON 数组');
    }
    
    // 验证和清理数据
    folders = folders.filter(f => f && f.folder && Array.isArray(f.ids));
    
    if (folders.length === 0) {
      throw new Error('未找到有效的分类建议');
    }
    
    // 将 ID 映射到书签对象
    const bookmarkMap = new Map(bookmarks.map(b => [String(b.id), b]));
    
    const result = folders.map(folder => ({
      folder: String(folder.folder).trim(),
      ids: (folder.ids || []).map(id => String(id)),
      bookmarks: (folder.ids || [])
        .map(id => bookmarkMap.get(String(id)))
        .filter(b => b !== undefined)
    })).filter(f => f.bookmarks.length > 0); // 只保留有书签的分类
    
    if (result.length === 0) {
      throw new Error('所有分类建议中的书签 ID 都不匹配');
    }
    
    return { folders: result };
  } catch (error) {
    console.error('解析 AI 响应失败:', error);
    console.error('原始响应:', responseText.substring(0, 500));
    
    // 最后尝试：使用更宽松的解析
    try {
      // 尝试提取所有可能的 JSON 对象
      const jsonObjects = [];
      const objectPattern = /\{[^{}]*"folder"[^{}]*"ids"[^{}]*\}/g;
      const matches = jsonText.match(objectPattern);
      
      if (matches && matches.length > 0) {
        for (const match of matches) {
          try {
            const obj = JSON.parse(match);
            if (obj.folder && Array.isArray(obj.ids)) {
              jsonObjects.push(obj);
            }
          } catch (e) {
            // 忽略单个对象解析错误
          }
        }
        
        if (jsonObjects.length > 0) {
          const bookmarkMap = new Map(bookmarks.map(b => [String(b.id), b]));
          const result = jsonObjects.map(folder => ({
            folder: String(folder.folder).trim(),
            ids: (folder.ids || []).map(id => String(id)),
            bookmarks: (folder.ids || [])
              .map(id => bookmarkMap.get(String(id)))
              .filter(b => b !== undefined)
          })).filter(f => f.bookmarks.length > 0);
          
          if (result.length > 0) {
            console.warn('使用宽松模式解析成功，但可能不完整');
            return { folders: result };
          }
        }
      }
    } catch (fallbackError) {
      console.error('宽松解析也失败:', fallbackError);
    }
    
    throw new Error(`解析 AI 响应失败: ${error.message}。请检查 API 返回格式。`);
  }
}

// 合并文件夹建议（处理重复和冲突）
function mergeFolderSuggestions(allFolders) {
  const folderMap = new Map();
  
  // 合并相同文件夹路径的书签
  for (const folder of allFolders) {
    if (!folderMap.has(folder.folder)) {
      folderMap.set(folder.folder, {
        folder: folder.folder,
        bookmarks: []
      });
    }
    
    const existing = folderMap.get(folder.folder);
    // 合并书签，去重
    const bookmarkIds = new Set(existing.bookmarks.map(b => b.id));
    for (const bookmark of folder.bookmarks) {
      if (!bookmarkIds.has(bookmark.id)) {
        existing.bookmarks.push(bookmark);
        bookmarkIds.add(bookmark.id);
      }
    }
  }
  
  return Array.from(folderMap.values());
}

// 发送分类进度
function sendClassifyProgress(message) {
  chrome.runtime.sendMessage({
    type: 'classifyProgress',
    data: { message }
  }).catch(() => {}); // 忽略错误
}

// 重构书签
async function restructureBookmarks(data) {
  try {
    // 删除失效链接
    for (const bookmark of data.broken) {
      try {
        await chrome.bookmarks.remove(bookmark.id);
        console.log(`Removed broken bookmark: ${bookmark.title}`);
      } catch (error) {
        console.error(`Error removing bookmark ${bookmark.id}:`, error);
      }
    }
    
    // 处理重复项（保留第一个，删除其余的）
    for (const group of data.duplicates) {
      for (let i = 1; i < group.length; i++) {
        try {
          await chrome.bookmarks.remove(group[i].id);
          console.log(`Removed duplicate bookmark: ${group[i].title}`);
        } catch (error) {
          console.error(`Error removing duplicate ${group[i].id}:`, error);
        }
      }
    }
    
    // 应用分类建议
    for (const suggestion of data.suggestions) {
      try {
        // 查找或创建分类文件夹
        const categoryFolder = await findOrCreateFolder(suggestion.suggestedCategory);
        
        // 移动书签到分类文件夹
        await chrome.bookmarks.move(suggestion.id, {
          parentId: categoryFolder.id
        });
        
        console.log(`Moved bookmark to category: ${suggestion.title} -> ${suggestion.suggestedCategory}`);
      } catch (error) {
        console.error(`Error moving bookmark ${suggestion.id}:`, error);
      }
    }
    
    console.log('Bookmark restructure completed');
  } catch (error) {
    console.error('Restructure error:', error);
    throw error;
  }
}

// 查找或创建文件夹
async function findOrCreateFolder(folderName) {
  const tree = await chrome.bookmarks.getTree();
  
  // 递归查找文件夹
  function findFolder(nodes, name) {
    for (const node of nodes) {
      if (!node.url && node.title === name) {
        return node;
      }
      if (node.children) {
        const found = findFolder(node.children, name);
        if (found) return found;
      }
    }
    return null;
  }
  
  const existing = findFolder(tree, folderName);
  if (existing) {
    return existing;
  }
  
  // 创建新文件夹
  const newFolder = await chrome.bookmarks.create({
    title: folderName,
    parentId: tree[0].id // 根文件夹
  });
  
  return newFolder;
}

// 查找或创建多级文件夹
async function findOrCreateFolderPath(folderPath) {
  const tree = await chrome.bookmarks.getTree();
  const rootId = tree[0].id;
  const parts = folderPath.split('/').filter(p => p.trim());
  
  let currentParentId = rootId;
  
  for (const part of parts) {
    const folderName = part.trim();
    if (!folderName) continue;
    
    // 在当前父文件夹下查找
    const children = await chrome.bookmarks.getChildren(currentParentId);
    let folder = children.find(child => !child.url && child.title === folderName);
    
    if (!folder) {
      // 创建新文件夹
      folder = await chrome.bookmarks.create({
        title: folderName,
        parentId: currentParentId
      });
    }
    
    currentParentId = folder.id;
  }
  
  return { id: currentParentId, title: parts[parts.length - 1] };
}

// 导出书签为 HTML 格式（Netscape Bookmark 格式）
async function exportBookmarks() {
  try {
    const tree = await chrome.bookmarks.getTree();
    const html = generateBookmarkHTML(tree);
    
    // 生成文件名：ReShelf_Backup_YYYY-MM-DD_HH-MM-SS.html
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const filename = `ReShelf_Backup_${year}-${month}-${day}_${hours}-${minutes}-${seconds}.html`;
    
    return { html, filename };
  } catch (error) {
    console.error('Export bookmarks error:', error);
    throw error;
  }
}

// 生成 Netscape Bookmark HTML 格式
function generateBookmarkHTML(tree) {
  let html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file.
     It will be read and overwritten.
     DO NOT EDIT! -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><P>
`;

  function processNode(node, indent = '') {
    if (node.url) {
      // 书签项
      const addDate = node.dateAdded ? Math.floor(node.dateAdded / 1000) : Math.floor(Date.now() / 1000);
      const title = escapeHtml(node.title || 'Untitled');
      const url = escapeHtml(node.url || '');
      html += `${indent}<DT><A HREF="${url}" ADD_DATE="${addDate}">${title}</A>\n`;
    } else if (node.children) {
      // 文件夹
      const addDate = node.dateAdded ? Math.floor(node.dateAdded / 1000) : Math.floor(Date.now() / 1000);
      const title = escapeHtml(node.title || 'Unnamed Folder');
      html += `${indent}<DT><H3 ADD_DATE="${addDate}">${title}</H3>\n`;
      html += `${indent}<DL><P>\n`;
      
      for (const child of node.children) {
        processNode(child, indent + '    ');
      }
      
      html += `${indent}</DL><P>\n`;
    }
  }
  
  // 处理根节点（通常是"Bookmarks Bar"和"Other Bookmarks"）
  for (const rootNode of tree) {
    if (rootNode.children) {
      for (const child of rootNode.children) {
        processNode(child, '    ');
      }
    }
  }
  
  html += `</DL><P>`;
  return html;
}

// HTML 转义
function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 删除重复项
async function removeDuplicates(duplicateGroups) {
  try {
    let removedCount = 0;
    
    for (const group of duplicateGroups) {
      if (group.length <= 1) continue;
      
      // 保留第一个，删除其余的
      for (let i = 1; i < group.length; i++) {
        try {
          await chrome.bookmarks.remove(group[i].id);
          removedCount++;
          console.log(`Removed duplicate: ${group[i].title}`);
        } catch (error) {
          console.error(`Error removing duplicate ${group[i].id}:`, error);
        }
      }
    }
    
    console.log(`Removed ${removedCount} duplicate bookmarks`);
    return { removedCount };
  } catch (error) {
    console.error('Remove duplicates error:', error);
    throw error;
  }
}

// 清理所有失效链接
async function cleanAllBroken(brokenBookmarks) {
  try {
    if (!brokenBookmarks || brokenBookmarks.length === 0) {
      return { removedCount: 0 };
    }
    
    let removedCount = 0;
    let failedCount = 0;
    
    // 批量删除失效链接
    for (const bookmark of brokenBookmarks) {
      try {
        await chrome.bookmarks.remove(bookmark.id);
        removedCount++;
        console.log(`Removed broken bookmark: ${bookmark.title} (${bookmark.url})`);
      } catch (error) {
        failedCount++;
        console.error(`Error removing broken bookmark ${bookmark.id}:`, error);
        // 继续处理下一个，不中断整个流程
      }
    }
    
    console.log(`Removed ${removedCount} broken bookmarks (${failedCount} failed)`);
    
    if (failedCount > 0) {
      console.warn(`${failedCount} bookmarks failed to remove`);
    }
    
    return { removedCount, failedCount };
  } catch (error) {
    console.error('Clean all broken error:', error);
    throw error;
  }
}

// 清理所有重复项（保留最早添加的）
async function cleanAllDuplicates(duplicateGroups) {
  try {
    if (!duplicateGroups || duplicateGroups.length === 0) {
      return { removedCount: 0 };
    }
    
    let removedCount = 0;
    let failedCount = 0;
    
    for (const group of duplicateGroups) {
      if (group.length <= 1) continue;
      
      // 按 dateAdded 排序，保留最早添加的
      const sortedGroup = [...group].sort((a, b) => {
        const dateA = a.dateAdded || 0;
        const dateB = b.dateAdded || 0;
        return dateA - dateB;
      });
      
      // 删除除最早之外的所有重复项
      for (let i = 1; i < sortedGroup.length; i++) {
        try {
          await chrome.bookmarks.remove(sortedGroup[i].id);
          removedCount++;
          console.log(`Removed duplicate: ${sortedGroup[i].title} (${sortedGroup[i].url})`);
        } catch (error) {
          failedCount++;
          console.error(`Error removing duplicate ${sortedGroup[i].id}:`, error);
          // 继续处理下一个
        }
      }
    }
    
    console.log(`Removed ${removedCount} duplicate bookmarks (${failedCount} failed)`);
    
    if (failedCount > 0) {
      console.warn(`${failedCount} duplicates failed to remove`);
    }
    
    return { removedCount, failedCount };
  } catch (error) {
    console.error('Clean all duplicates error:', error);
    throw error;
  }
}

// 整理书签（根据 AI 分类结果）
async function organizeBookmarks(data) {
  try {
    const { folders } = data;
    
    if (!folders || folders.length === 0) {
      throw new Error('没有可执行的分类方案');
    }
    
    console.log(`开始整理 ${folders.length} 个分类...`);
    
    // 为每个分类创建文件夹并移动书签
    for (const folderData of folders) {
      const { folder: folderPath, bookmarks } = folderData;
      
      if (!bookmarks || bookmarks.length === 0) {
        continue;
      }
      
      try {
        // 递归创建或查找文件夹
        const targetFolder = await findOrCreateFolderPath(folderPath);
        
        // 移动书签到目标文件夹
        for (const bookmark of bookmarks) {
          try {
            await chrome.bookmarks.move(bookmark.id, {
              parentId: targetFolder.id
            });
            console.log(`Moved: ${bookmark.title} -> ${folderPath}`);
          } catch (error) {
            console.error(`Error moving bookmark ${bookmark.id}:`, error);
          }
        }
      } catch (error) {
        console.error(`Error processing folder ${folderPath}:`, error);
        // 继续处理下一个文件夹
      }
    }
    
    console.log('Bookmark organization completed');
  } catch (error) {
    console.error('Organize error:', error);
    throw error;
  }
}

// 存储工具函数
async function getStorage(key) {
  const result = await chrome.storage.local.get(key);
  return result[key];
}

async function setStorage(key, value) {
  await chrome.storage.local.set({ [key]: value });
}
