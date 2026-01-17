// Background Service Worker
// 处理书签扫描、死链检测和 AI 分类

// 监听扩展安装
chrome.runtime.onInstalled.addListener(() => {
  console.log('ReShelf extension installed');
});
let isAbortRequested = false;
// 监听来自 side panel 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[background] 收到消息类型:', message.type); // 确保这一行在最前面
  if (message.type === 'stopClassification') {
    isAbortRequested = true;
    console.log('[background] 收到停止信号，正在拦截后续批次...');
  }
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
      console.log('[background] 收到 classifyBookmarks 请求');
    classifyBookmarks(message.data).then(result => {
        console.log('[background] 分类完成，准备发送结果:', {
            foldersCount: result.folders?.length || 0,
            totalBookmarks: result.totalBookmarks
        });
      // 发送结果到 side panel
      chrome.runtime.sendMessage({
        type: 'classifyComplete',
        data: result
      }).then(() => {
          console.log('[background] 分类结果已发送到 side panel');
      }).catch(err => {
          console.error('[background] 发送分类结果失败:', err);
      });
    }).catch(err => {
      console.error('[background] 分类错误:', err);
      chrome.runtime.sendMessage({
          type: 'classifyComplete', // 保持类型一致，但内部带上错误标识
          data: { 
              success: false, 
              error: err.message || '未知错误' 
          }
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

    if (message.type === 'testApiConnection') {
        testApiConnection(message.data).then(result => {
            sendResponse({ status: 'success', message: result.message });
        }).catch(err => {
            console.error('Test API connection error:', err);
            sendResponse({ status: 'error', error: err.message });
        });
        return true;
    }
    // background.js 里的消息监听部分

    if (message.type === 'restoreBookmarks') {
      // 执行递归创建逻辑
      executeRestore(message.data).then(() => {
        sendResponse({ status: 'success' });
      }).catch(err => {
        sendResponse({ status: 'error', error: err.message });
      });
      return true;
    }
    async function executeRestore(nodes, parentId = null) {
      if (!parentId) {
        const tree = await chrome.bookmarks.getTree();
        // 默认恢复到书签栏 (ID 1)
        parentId = tree[0].children[0].id; 
      }
    
      for (const node of nodes) {
        try {
          if (node.url) {
            await chrome.bookmarks.create({
              parentId: parentId,
              title: node.title,
              url: node.url
            });
          } else if (node.children) {
            // 创建原有的文件夹结构
            const newFolder = await chrome.bookmarks.create({
              parentId: parentId,
              title: node.title
            });
            // 递归进入下一层
            await executeRestore(node.children, newFolder.id);
          }
        } catch (e) {
          console.error(`恢复节点 ${node.title} 失败:`, e);
          // 遇到个别错误继续执行，不中断整个过程
        }
      }
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
async function checkLinkStatus(bookmark) {
  // 过滤浏览器内部协议 (chrome://, edge://, about:, file:// 等)
  if (!bookmark.url.startsWith('http')) {
    return null; // 认为内部链接是有效的，不进行 fetch 测试
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    
    const response = await fetch(bookmark.url, {
      method: 'HEAD',
      mode: 'no-cors',
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    return null;
  } catch (error) {
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

// background.js - 增强型分类主函数（具备跳过报错批次的功能）
async function classifyBookmarks(data) {
  isAbortRequested = false;
  console.log('[classifyBookmarks] ========== 开始分类任务 ==========');
  
  const { bookmarks, apiProvider, apiKey, apiBaseUrl, aggregationLevel = 'medium' } = data;

  // 1. 尝试从本地存储恢复断点进度
  const storage = await chrome.storage.local.get(['classify_cache', 'last_index']);
  let allFolders = storage.classify_cache || []; 
  let windowStart = storage.last_index || 0;

  const validBookmarks = bookmarks.filter(b => b && b.id && b.title && b.url);
  const BATCH_SIZE = 25; 
  const WINDOW_OVERLAP = 5;

  // 启动心跳守护
  const keepAliveTimer = setInterval(() => {
      chrome.runtime.getPlatformInfo(() => {
          console.log('[SW-Guard] 强力心跳维持中...', new Date().toLocaleTimeString());
      });
  }, 20000);

  try {
      while (windowStart < validBookmarks.length) {
          if (isAbortRequested) {
              sendClassifyProgress('🚫 任务已由用户手动中止');
              return;
          }

          const windowEnd = Math.min(windowStart + BATCH_SIZE, validBookmarks.length);
          const batch = validBookmarks.slice(windowStart, windowEnd);
          const batchNumber = Math.floor(windowStart / (BATCH_SIZE - WINDOW_OVERLAP)) + 1;
          const totalBatches = Math.ceil(validBookmarks.length / (BATCH_SIZE - WINDOW_OVERLAP));

          sendClassifyProgress(`正在处理第 ${batchNumber}/${totalBatches} 批书签...`);

          try {
              // 发起 API 请求（带之前实现的超时控制）
              const batchResult = await callAIClassifyAPI(batch, apiProvider, apiKey, apiBaseUrl, [], aggregationLevel);

              if (batchResult && batchResult.folders) {
                  allFolders.push(...batchResult.folders);
                  console.log(`[Batch ${batchNumber}] 成功获取分类建议`);
              } else {
                  console.warn(`[Batch ${batchNumber}] AI 响应有效但未给出建议，将归入“未分类”`);
              }

          } catch (error) {
              // 【核心优化】针对单批次失败的处理
              console.error(`[Batch ${batchNumber}] 发生错误:`, error.message);
              
              // 只有欠费类错误才彻底中断，其他错误（如 429、超时、Failed to fetch）一律记录后跳过
              if (error.message.includes('余额不足') || error.message.includes('请充值')) {
                  throw error; 
              }
              
              sendClassifyProgress(`⚠️ 第 ${batchNumber} 批响应异常 (${error.message.substring(0,15)}...)，已自动跳过`);
              // 此处不抛出错误，以便循环继续执行
          }

          // 【关键关键】无论成功还是失败，都必须推进指针并保存进度，防止死循环
          windowStart += (BATCH_SIZE - WINDOW_OVERLAP);
          
          await chrome.storage.local.set({
              'classify_cache': allFolders,
              'last_index': windowStart
          });
          
          // 批次间强制冷却，防止触发 API 频率限制
          await new Promise(r => setTimeout(r, 2000));
      }

      // 2. 全部批次走完，清理本地缓存
      await chrome.storage.local.remove(['classify_cache', 'last_index']);
      console.log('[classifyBookmarks] 所有批次处理结束，正在合并结果...');

      // 执行合并与去重逻辑
      let mergedFolders = mergeFolderSuggestions(allFolders);
      mergedFolders = applyAggregationRules(mergedFolders, aggregationLevel);

      return {
          folders: mergedFolders,
          totalBookmarks: validBookmarks.length,
          processedCount: validBookmarks.length
      };

  } catch (fatalError) {
      console.error('[classifyBookmarks] 任务因致命错误中断:', fatalError);
      throw fatalError;
  } finally {
      // 确保清除心跳定时器
      clearInterval(keepAliveTimer);
      console.log('[SW-Guard] 心跳已停止');
  }
}
// 调用 AI API（支持 Gemini 和智谱 AI）
async function callAIClassifyAPI(bookmarks, provider, apiKey, baseUrl, existingFolders = [], aggregationLevel = 'medium') {
    console.log('[callAIClassifyAPI] ========== API 调用拦截器 ==========');
    console.log('[callAIClassifyAPI] 开始构建 Prompt...');
    const prompt = buildClassificationPrompt(bookmarks, existingFolders, aggregationLevel);
    console.log('[callAIClassifyAPI] Prompt 长度:', prompt.length, '字符');
    console.log('[callAIClassifyAPI] Prompt 完整内容:');
    console.log('--- Prompt Start ---');
    console.log(prompt);
    console.log('--- Prompt End ---');
    console.log('[callAIClassifyAPI] Prompt 预览 (前500字符):', prompt.substring(0, 500));
  
  if (provider === 'gemini') {
      console.log('[callAIClassifyAPI] 使用 Gemini API');
    return await callGeminiAPI(bookmarks, prompt, apiKey, baseUrl);
  } else if (provider === 'zhipu') {
      console.log('[callAIClassifyAPI] 使用智谱 AI API');
    return await callZhipuAPI(bookmarks, prompt, apiKey, baseUrl);
  } else if (provider === 'openrouter') {
    return await callOpenRouterAPI(bookmarks, prompt, apiKey, baseUrl);
  } else {
    throw new Error(`不支持的 API 提供商: ${provider}`);
  }
}

// 应用聚合规则（后处理）
function applyAggregationRules(folders, aggregationLevel) {
    console.log('[applyAggregationRules] 开始应用聚合规则，级别:', aggregationLevel);

    // 1. 处理孤儿节点（只有一个书签的文件夹）
    const foldersToMerge = [];
    const validFolders = [];

    folders.forEach(folder => {
        const bookmarkCount = folder.bookmarks ? folder.bookmarks.length : 0;
        if (bookmarkCount === 1) {
            console.log(`[applyAggregationRules] 发现孤儿节点: ${folder.folder} (1个书签)`);
            foldersToMerge.push(folder);
        } else {
            validFolders.push(folder);
        }
    });

    // 将孤儿节点合并到父类或"其他"
    foldersToMerge.forEach(orphan => {
        const parts = orphan.folder.split('/');
        if (parts.length > 1) {
            // 有父类，合并到父类
            const parentPath = parts.slice(0, -1).join('/');
            const parentFolder = validFolders.find(f => f.folder === parentPath);
            if (parentFolder) {
                console.log(`[applyAggregationRules] 将 ${orphan.folder} 合并到父类 ${parentPath}`);
                parentFolder.bookmarks = parentFolder.bookmarks || [];
                parentFolder.bookmarks.push(...(orphan.bookmarks || []));
            } else {
                // 找不到父类，合并到"其他"
                let otherFolder = validFolders.find(f => f.folder.endsWith('/其他') || f.folder === '其他');
                if (!otherFolder) {
                    const topLevel = parts[0];
                    otherFolder = {
                        folder: `${topLevel}/其他`,
                        bookmarks: []
                    };
                    validFolders.push(otherFolder);
                }
                console.log(`[applyAggregationRules] 将 ${orphan.folder} 合并到 ${otherFolder.folder}`);
                otherFolder.bookmarks.push(...(orphan.bookmarks || []));
            }
        } else {
            // 单层，合并到"其他"
            let otherFolder = validFolders.find(f => f.folder === '其他');
            if (!otherFolder) {
                otherFolder = {
                    folder: '其他',
                    bookmarks: []
                };
                validFolders.push(otherFolder);
            }
            console.log(`[applyAggregationRules] 将 ${orphan.folder} 合并到 其他`);
            otherFolder.bookmarks.push(...(orphan.bookmarks || []));
        }
    });

    // 2. 处理少于3个书签的文件夹（根据聚合度）
    if (aggregationLevel !== 'low') {
        const smallFolders = validFolders.filter(f => {
            const count = f.bookmarks ? f.bookmarks.length : 0;
            return count > 0 && count < 3;
        });

        smallFolders.forEach(smallFolder => {
            const parts = smallFolder.folder.split('/');
            if (parts.length > 1) {
                // 合并到父类
                const parentPath = parts.slice(0, -1).join('/');
                const parentFolder = validFolders.find(f => f.folder === parentPath && f !== smallFolder);
                if (parentFolder) {
                    console.log(`[applyAggregationRules] 将小文件夹 ${smallFolder.folder} (${smallFolder.bookmarks.length}个) 合并到父类 ${parentPath}`);
                    parentFolder.bookmarks = parentFolder.bookmarks || [];
                    parentFolder.bookmarks.push(...(smallFolder.bookmarks || []));
                    // 标记为待删除
                    smallFolder._toRemove = true;
                }
            }
        });

        // 移除标记的文件夹
        return validFolders.filter(f => !f._toRemove);
    }

    return validFolders;
}

// 构建分类提示词（优化版：增加硬约束）
function buildClassificationPrompt(bookmarks, existingFolders = [], aggregationLevel = 'medium') {
  const totalCount = bookmarks.length; // 获取当前批次的总数
  const bookmarksList = bookmarks.map((b, index) => 
    `${index + 1}. 标题: "${b.title}", URL: ${b.url}, ID: ${b.id}`
  ).join('\n');
  
    // 聚合度提示
    let aggregationHint = '';
    if (aggregationLevel === 'high') {
        aggregationHint = '重要：使用高度聚合策略，只创建 5-10 个核心大类（如：编程开发、设计素材、学术论文、影音娱乐、工具软件、新闻资讯、社交网络、其他）。';
    } else if (aggregationLevel === 'low') {
        aggregationHint = '可以使用较精细的分类，但必须遵守以下约束。';
    } else {
        aggregationHint = '使用中等聚合度，平衡精细度和可管理性。';
    }

    // 已有文件夹名称（用于一致性）
    let existingFoldersHint = '';
    if (existingFolders.length > 0) {
        const folderNames = existingFolders.map(f => f.folder).join('、');
        existingFoldersHint = `\n已有文件夹参考（请尽量复用这些名称）：${folderNames}\n`;
    }
  const existingHint = existingFolders.length > 0 
    ? `### 动态约束（极其重要）：
目前已经建立了以下分类：[${existingFolders.join('、')}]。
你的首要任务是【将新书签归入上述已有分类】。只有当现有分类完全无法容纳新书签时，才允许创建新分类。严禁创建语义重合的分类（例如有了“编程”就不要再建“代码”）。`
    : `### 分类原则：
请使用宽泛、具有高度概括性的专业术语作为一级目录。避免使用“相关”、“资源”、“技术”等冗余后缀。`;
  return `你是资深数字图书管理员。${existingHint}。现在有 ${totalCount} 个书签需要分类。根据书签的标题和URL推断所属领域，建议层级分明的文件夹结构。

${aggregationHint}

硬约束（必须严格遵守）：
1. 合并准则：如果某个特定主题的书签少于 3 个，必须将其向上合并到更通用的父文件夹中。
   - 例如：不要创建"React 钩子"和"React 路由"，统一归类为"前端/React"
   - 例如：不要创建"Python 爬虫"和"Python 数据分析"，统一归类为"编程/Python"

2. 大类优先：优先使用宽泛且专业的术语。
   - 推荐大类：编程开发、设计素材、学术论文、影音娱乐、工具软件、新闻资讯、社交网络、学习资源、工作相关、生活服务、其他
   - 避免过于细分的小类

3. 深度限制：严禁生成超过 3 层的嵌套目录。
   - 最多格式：大类/中类/小类（如："编程/前端/React"）
   - 推荐格式：大类/中类（如："编程/前端"）或单层（如："编程"）

4. 孤儿节点处理：严禁出现只有一个书签的文件夹。
   - 如果某个分类只有一个书签，必须将其合并到父类或"其他"文件夹
   - 无法合并的，放入该大类下的"其他"或"未分类"文件夹

5. 文件夹命名一致性：
   - 使用简洁、通用的中文名称
   - 避免使用英文缩写（除非是通用术语如"AI"、"UI"）
   - 保持命名风格统一${existingFoldersHint}

6. 百分之百覆盖：
   - 必须处理所有 ${totalCount} 个 ID，严禁遗漏任何一个 ID。
   - 重要：不要创建空文件夹，确保每个 ID 都被正确分类。

书签列表：
${bookmarksList}

重要：只返回合法的 JSON 数组，格式为 [{"folder": "父目录/子目录", "ids": ["id1", "id2"]}]。不要任何开场白、解释或 markdown 代码块标记。`;
}

// 调用 Gemini API
async function callGeminiAPI(bookmarks, prompt, apiKey, baseUrl) {
  // Gemini API 格式: https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={apiKey}
    // 使用 gemini-flash-latest
    const model = 'gemini-flash-latest';
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
  
    console.log('[callGeminiAPI] 请求 URL:', url.replace(apiKey, '***'));
    console.log('[callGeminiAPI] 请求体大小:', JSON.stringify({
        contents: [{
            parts: [{
                text: prompt
            }]
        }]
    }).length, '字节');

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
  
    console.log('[callGeminiAPI] 响应状态:', response.status, response.statusText);

    if (!response.ok) {
        const errorText = await response.text();
        console.error('[callGeminiAPI] ========== API 错误响应 ==========');
        console.error('[callGeminiAPI] 状态码:', response.status);
        console.error('[callGeminiAPI] 状态文本:', response.statusText);
        console.error('[callGeminiAPI] 错误响应体:', errorText);
        console.error('[callGeminiAPI] 可能的原因:');
        if (response.status === 401 || response.status === 403) {
            console.error('  - API Key 无效或已过期');
        } else if (response.status === 429) {
            console.error('  - API 调用频率超限');
        } else if (response.status === 402 || response.status === 403) {
            console.error('  - 账户欠费或配额不足');
        } else if (response.status >= 500) {
            console.error('  - 服务器错误，可能是网络问题');
        }
        throw new Error(`Gemini API 错误: ${response.status} - ${errorText}`);
    }
  
  const data = await response.json();
    console.log('[callGeminiAPI] 响应数据结构:', {
        hasCandidates: !!data.candidates,
        candidatesCount: data.candidates?.length || 0,
        hasContent: !!(data.candidates?.[0]?.content)
    });
  
  // 提取响应文本
  let responseText = '';
  if (data.candidates && data.candidates[0] && data.candidates[0].content) {
    responseText = data.candidates[0].content.parts[0].text;
      console.log('[callGeminiAPI] 响应文本长度:', responseText.length, '字符');
      console.log('[callGeminiAPI] 响应文本预览:', responseText.substring(0, 300));
  } else {
      console.warn('[callGeminiAPI] 响应中未找到有效内容:', data);
  }
  
  return parseAIResponse(responseText, bookmarks);
}

async function callOpenRouterAPI(bookmarks, prompt, apiKey, baseUrl) {
  const apiUrl = baseUrl || 'https://openrouter.ai/api/v1/chat/completions';
  
  // 创建一个 60 秒自动断开的控制器
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 180000); 
  if (!apiUrl.startsWith('http')) {
    throw new Error('API 地址必须以 http:// 或 https:// 开头，请检查设置');
  }

  try {
      const response = await fetch(apiUrl, {
          method: 'POST',
          headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`
          },
          signal: controller.signal, // 绑定超时信号
          body: JSON.stringify({
              model: OPENROUTER_FREE_MODEL,
              messages: [
                  { role: 'system', content: '你是一位资深的图书管理员。请只返回 JSON 格式。' },
                  { role: 'user', content: prompt }
              ],
              temperature: 0.3
          })
      });

      clearTimeout(timeoutId); // 成功响应则清除定时器

      if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`API 错误: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      return parseAIResponse(data.choices?.[0]?.message?.content, bookmarks);
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('API 响应超时（3分钟），模型响应太慢，请尝试减少批次大小或检查网络。');
    }
    console.error('[Network Error Details]:', error); // 打印完整错误
    if (!navigator.onLine) {
        throw new Error('网络连接已断开，请检查网络设置。');
    }
    throw new Error(`网络请求失败: ${error.message}。请检查 API URL 是否正确或代理是否开启。`);
  }
}
// 解析 AI 响应（加强错误处理）
function parseAIResponse(responseText, bookmarks) {
    console.log('[parseAIResponse] ========== 解析器鲁棒性检查 ==========');
    console.log('[parseAIResponse] 原始文本长度:', responseText?.length || 0);

    if (!responseText || responseText.trim().length === 0) {
        console.error('[parseAIResponse] 响应文本为空');
        throw new Error('AI 返回的响应为空');
    }

    // 保存原始文本用于调试
    const rawText = responseText.trim();
    console.log('[parseAIResponse] 原始文本完整内容:');
    console.log('--- Raw Text Start ---');
    console.log(rawText);
    console.log('--- Raw Text End ---');
    console.log('[parseAIResponse] 原始文本预览 (前500字符):', rawText.substring(0, 500));

    let jsonText = rawText;

    // 方法1: 移除 markdown 代码块标记（支持多种格式）
    // 处理 ```json ... ``` 格式
  jsonText = jsonText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '');
    // 处理 ``` ... ``` 格式（没有 json 标记）
    jsonText = jsonText.replace(/^```\s*/i, '').replace(/\s*```$/i, '');
  jsonText = jsonText.trim();
    console.log('[parseAIResponse] 移除 markdown 后长度:', jsonText.length);
    console.log('[parseAIResponse] 移除 markdown 后预览:', jsonText.substring(0, 300));
  
    // 方法2: 使用正则提取 JSON 数组（更宽松的匹配）
  const jsonArrayMatch = jsonText.match(/\[[\s\S]*\]/);
  if (jsonArrayMatch) {
    jsonText = jsonArrayMatch[0];
      console.log('[parseAIResponse] 使用正则提取 JSON 数组，长度:', jsonText.length);
  } else {
      console.warn('[parseAIResponse] 未找到 JSON 数组模式，尝试直接解析');
  }
  
  // 方法3: 尝试修复常见的 JSON 格式问题
  try {
      console.log('[parseAIResponse] 尝试修复 JSON 格式问题...');
    // 移除可能的注释
    jsonText = jsonText.replace(/\/\/.*$/gm, '');
    // 移除尾随逗号
    jsonText = jsonText.replace(/,(\s*[}\]])/g, '$1');
    
      console.log('[parseAIResponse] 修复后 JSON 预览:', jsonText.substring(0, 300));

    // 解析 JSON
    let folders = JSON.parse(jsonText);
      console.log('[parseAIResponse] JSON 解析成功，获得', folders.length, '个分类');
    
    if (!Array.isArray(folders)) {
        console.error('[parseAIResponse] 解析结果不是数组:', typeof folders);
      throw new Error('响应格式错误：期望 JSON 数组');
    }
    
    // 验证和清理数据
    folders = folders.filter(f => f && f.folder && Array.isArray(f.ids));
      console.log('[parseAIResponse] 验证后有效分类数:', folders.length);
    
    if (folders.length === 0) {
      throw new Error('未找到有效的分类建议');
    }
    
    // 将 ID 映射到书签对象
    const bookmarkMap = new Map(bookmarks.map(b => [String(b.id), b]));
      console.log('[parseAIResponse] 书签映射表大小:', bookmarkMap.size);
    
    const result = folders.map(folder => ({
      folder: String(folder.folder).trim(),
      ids: (folder.ids || []).map(id => String(id)),
      bookmarks: (folder.ids || [])
        .map(id => bookmarkMap.get(String(id)))
        .filter(b => b !== undefined)
    })).filter(f => f.bookmarks.length > 0); // 只保留有书签的分类
    
      console.log('[parseAIResponse] 最终结果:', {
          totalFolders: result.length,
          folders: result.map(f => ({ folder: f.folder, count: f.bookmarks.length }))
      });

      if (result.length === 0) {
          console.error('[parseAIResponse] ========== 解析结果为空 ==========');
          console.error('[parseAIResponse] 原始文本:', rawText);
          console.error('[parseAIResponse] 清理后文本:', jsonText);
          console.error('[parseAIResponse] 解析的文件夹数:', folders.length);
          console.error('[parseAIResponse] 验证后文件夹数:', folders.filter(f => f && f.folder && Array.isArray(f.ids)).length);
          console.error('[parseAIResponse] 书签映射表大小:', bookmarkMap.size);
          throw new Error('所有分类建议中的书签 ID 都不匹配。原始响应已打印到控制台。');
      }

      console.log('[parseAIResponse] ========== 解析成功 ==========');
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

// background.js 启发式合并函数
function mergeFolderSuggestions(allFolders) {
  const folderMap = new Map();

  // 按长度排序，先处理短的（核心词），后处理长的（扩展词）
  const sortedFolders = allFolders.sort((a, b) => a.folder.length - b.folder.length);

  for (const item of sortedFolders) {
    let targetFolder = item.folder;

    // 自动归一化逻辑：遍历已有的 key，检查是否存在语义包含关系
    for (const existingKey of folderMap.keys()) {
      // 场景 A：完全包含（如 “编程” 包含在 “编程开发” 中，或反之）
      // 场景 B：前缀重合（如 “游戏” 与 “游戏娱乐”）
      const isSimilar = 
        targetFolder.includes(existingKey) || 
        existingKey.includes(targetFolder) ||
        (targetFolder.substring(0, 2) === existingKey.substring(0, 2)); // 前两个字相同通常意味着语义接近

      if (isSimilar) {
        // 倾向于保留更短、更通用的名称，或者保留第一个出现的名称
        targetFolder = existingKey;
        break; 
      }
    }

    if (!folderMap.has(targetFolder)) {
      folderMap.set(targetFolder, { folder: targetFolder, bookmarks: [] });
    }
    
    // 合并书签...
    const current = folderMap.get(targetFolder);
    item.bookmarks.forEach(b => {
      if (!current.bookmarks.find(eb => eb.id === b.id)) {
        current.bookmarks.push(b);
      }
    });
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
const OPENROUTER_FREE_MODEL = "z-ai/glm-4.5-air:free";
// 测试 API 连接
async function testApiConnection(data) {
    const { apiProvider, apiKey, apiBaseUrl } = data;

    console.log('[testApiConnection] 开始测试 API 连接:', {
        provider: apiProvider,
        hasKey: !!apiKey,
        keyLength: apiKey?.length || 0,
        baseUrl: apiBaseUrl || '默认'
    });

    try {
        const testPrompt = 'Hi';
        let response;

        if (apiProvider === 'gemini') {
            const model = 'gemini-flash-latest';
            let url;
            if (!url.startsWith('http')) {
              throw new Error('API 地址必须以 http:// 或 https:// 开头');
            }
            if (apiBaseUrl && apiBaseUrl.trim()) {
                url = apiBaseUrl.endsWith('/') ? apiBaseUrl.slice(0, -1) : apiBaseUrl;
                if (!url.includes('models/')) {
                    url = `${url}/models/${model}:generateContent`;
                }
                url = `${url}?key=${apiKey}`;
            } else {
                url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
            }

            console.log('[testApiConnection] Gemini 测试 URL:', url.replace(apiKey, '***'));

            response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    contents: [{
                        parts: [{
                            text: testPrompt
                        }]
                    }]
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error('[testApiConnection] Gemini API 错误:', response.status, errorText);
                throw new Error(`Gemini API 错误 (${response.status}): ${errorText.substring(0, 200)}`);
            }

            const data = await response.json();
            console.log('[testApiConnection] Gemini 响应成功:', !!data.candidates);

        } else if (apiProvider === 'zhipu') {
            const apiUrl = apiBaseUrl || 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

            console.log('[testApiConnection] 智谱 AI 测试 URL:', apiUrl);

            response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model: 'glm-4',
                    messages: [
                        {
                            role: 'user',
                            content: testPrompt
                        }
                    ],
                    temperature: 0.7
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error('[testApiConnection] 智谱 AI API 错误:', response.status, errorText);
                throw new Error(`智谱 AI API 错误 (${response.status}): ${errorText.substring(0, 200)}`);
            }

            const data = await response.json();
            console.log('[testApiConnection] 智谱 AI 响应成功:', !!data.choices);

        } else if (apiProvider === 'openrouter') {
          const apiUrl = apiBaseUrl || 'https://openrouter.ai/api/v1/chat/completions';
          
          const response = await fetch(apiUrl, {
              method: 'POST',
              headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${apiKey}`,
                  'HTTP-Referer': 'https://github.com/kunmeigo/ReShelf',
                  'X-Title': 'ReShelf'
              },
              body: JSON.stringify({
                  model: OPENROUTER_FREE_MODEL, // 使用变量
                  messages: [{ role: 'user', content: 'Hi' }]
              })
          });
  
          if (!response.ok) {
              const errorText = await response.text();
              throw new Error(`OpenRouter 错误 (${response.status}): ${errorText}`);
          }
      } else {
            throw new Error(`不支持的 API 提供商: ${apiProvider}`);
        }

        console.log('[testApiConnection] API 连接测试成功');
        return { message: 'API 连接测试成功！' };

    } catch (error) {
        console.error('[testApiConnection] 测试失败:', error);
        throw error;
    }
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
async function findOrCreateFolderPath(folderPath) {
  const tree = await chrome.bookmarks.getTree();
  // tree[0].children[0] 通常就是你的“书签栏”
  const rootId = tree[0].children[0].id; 
  
  const parts = folderPath.split('/').filter(p => p.trim());
  let currentParentId = rootId;
  
  for (const part of parts) {
    const folderName = part.trim();
    if (!folderName) continue;
    
    const children = await chrome.bookmarks.getChildren(currentParentId);
    let folder = children.find(child => !child.url && child.title === folderName);
    
    if (!folder) {
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
    const { folders, originalBookmarks } = data; // 获取分类建议和原始列表
    
    if (!folders || folders.length === 0) {
      throw new Error('没有可执行的分类方案');
    }

    // 1. 建立已分类 ID 的集合 (Set)，提高查询效率
    const categorizedIds = new Set();
    folders.forEach(f => {
      if (f.ids) {
        f.ids.forEach(id => categorizedIds.add(String(id)));
      }
    });
    const missingBookmarks = originalBookmarks.filter(b => !categorizedIds.has(String(b.id)));
    console.log(`[Organize] 计划移动: ${categorizedIds.size} 个, 兜底移动: ${missingBookmarks.length} 个`);
    
    // 为每个分类创建文件夹并移动书签
    for (const folderData of folders) {
      const { folder: folderPath, bookmarks } = folderData;
      if (!bookmarks || bookmarks.length === 0) continue;
      try {
        const targetFolder = await findOrCreateFolderPath(folderPath);
        for (const bookmark of bookmarks) {
          await safeMoveBookmark(bookmark.id, targetFolder.id);
        }
      } catch (error) {
        console.error(`Error processing folder ${folderPath}:`, error);
        // 继续处理下一个文件夹
      }
    }
    if (missingBookmarks.length > 0) {
      console.log(`[Organize] 正在处理 ${missingBookmarks.length} 个遗漏项至“待手动分类”...`);
      const fallbackFolder = await findOrCreateFolderPath('待手动分类');
      for (const bookmark of missingBookmarks) {
        await safeMoveBookmark(bookmark.id, fallbackFolder.id);
      }
    }
    await Promise.all([
      cleanEmptyFolders('1'),
      cleanEmptyFolders('2')
    ]);
    console.log('Bookmark organization completed');
  } catch (error) {
    console.error('Organize error:', error);
    throw error;
  }
}
async function safeMoveBookmark(id, parentId) {
  try {
    const existCheck = await chrome.bookmarks.get(id).catch(() => null);
    if (existCheck) {
      await chrome.bookmarks.move(id, { parentId });
    }
  } catch (e) {
    console.warn(`[Skip] 移动失败 (ID: ${id}):`, e);
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

/**
 * 递归清理空文件夹 (自下而上)
 * @param {string} folderId 当前检查的文件夹 ID
 */
async function cleanEmptyFolders(folderId) {
  // 系统保留文件夹 ID (0: 根, 1: 书签栏, 2: 其他书签, 3: 移动书签)
  const protectedIds = ['0', '1', '2', '3'];
  
  const children = await chrome.bookmarks.getChildren(folderId);
  
  // 1. 先递归处理所有子文件夹
  for (const child of children) {
    if (!child.url) { // 如果是文件夹
      await cleanEmptyFolders(child.id);
    }
  }

  // 2. 处理完子项后，重新获取当前文件夹的状态
  const updatedChildren = await chrome.bookmarks.getChildren(folderId);
  
  // 3. 如果文件夹现在变空了，且不是受保护的系统文件夹，则执行删除
  if (updatedChildren.length === 0 && !protectedIds.includes(folderId)) {
    try {
      await chrome.bookmarks.remove(folderId);
      console.log(`[Cleanup] 已删除空文件夹: ID ${folderId}`);
    } catch (e) {
      console.warn(`[Cleanup] 删除文件夹 ${folderId} 失败（可能已被删除）:`, e);
    }
  }
}