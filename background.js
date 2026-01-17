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

    if (message.type === 'testApiConnection') {
        testApiConnection(message.data).then(result => {
            sendResponse({ status: 'success', message: result.message });
        }).catch(err => {
            console.error('Test API connection error:', err);
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
    console.log('[classifyBookmarks] ========== 开始分类 ==========');
    console.log('[classifyBookmarks] 接收到的原始数据:', {
        bookmarksCount: data.bookmarks?.length || 0,
        apiProvider: data.apiProvider,
        hasApiKey: !!data.apiKey,
        apiKeyLength: data.apiKey?.length || 0,
        apiBaseUrl: data.apiBaseUrl || '使用默认'
    });

  const { bookmarks, apiProvider, apiKey, apiBaseUrl } = data;

    // 1. 数据输入检查 (The Input Gate)
    console.log('[classifyBookmarks] 待分类原始数据 (前10个):',
        bookmarks?.slice(0, 10).map(b => ({ id: b.id, title: b.title, url: b.url })) || []
    );

    // API Key 检查
    if (!apiKey || apiKey.trim().length === 0) {
        const errorMsg = 'API Key 为空，请先在设置中配置 API Key';
        console.error('[classifyBookmarks]', errorMsg);
        throw new Error(errorMsg);
    }

    // 数据有效性检查
    if (!bookmarks || !Array.isArray(bookmarks) || bookmarks.length === 0) {
        const errorMsg = '未找到可分类的有效书签';
        console.error('[classifyBookmarks]', errorMsg);
        throw new Error(errorMsg);
    }

    // 过滤掉无效书签
    const validBookmarks = bookmarks.filter(b => b && b.id && b.title && b.url);
    console.log(`[classifyBookmarks] 原始书签数: ${bookmarks.length}, 有效书签数: ${validBookmarks.length}`);

    if (validBookmarks.length === 0) {
        const errorMsg = '未找到可分类的有效书签（所有书签都缺少必要字段）';
        console.error('[classifyBookmarks]', errorMsg);
        throw new Error(errorMsg);
    }

  const BATCH_SIZE = 20;
  const WINDOW_OVERLAP = 5; // 滑动窗口重叠数量
  const allFolders = [];
  
  try {
      console.log(`[classifyBookmarks] 准备处理 ${validBookmarks.length} 个有效书签`);
      console.log('[classifyBookmarks] API 配置:', {
          provider: apiProvider,
          hasKey: !!apiKey,
          keyLength: apiKey.length,
          keyPreview: apiKey.substring(0, 8) + '...',
          baseUrl: apiBaseUrl || '默认'
      });

    // 发送进度更新
    sendClassifyProgress('开始分析书签...');
    
    // 滑动窗口批处理
    let processedCount = 0;
    let windowStart = 0;
    
      while (windowStart < validBookmarks.length) {
          const windowEnd = Math.min(windowStart + BATCH_SIZE, validBookmarks.length);
          const batch = validBookmarks.slice(windowStart, windowEnd);
      const batchNumber = Math.floor(windowStart / (BATCH_SIZE - WINDOW_OVERLAP)) + 1;
          const estimatedBatches = Math.ceil(validBookmarks.length / (BATCH_SIZE - WINDOW_OVERLAP));
      
          sendClassifyProgress(`正在分析第 ${batchNumber} 批书签 (${windowStart + 1}-${windowEnd}/${validBookmarks.length})...`);
      
      try {
          console.log(`[classifyBookmarks] 处理批次 ${batchNumber}/${estimatedBatches}:`, {
              batchSize: batch.length,
              windowRange: `${windowStart + 1}-${windowEnd}`,
              sampleBookmarks: batch.slice(0, 3).map(b => ({ id: b.id, title: b.title }))
          });

        // 调用 AI API
          console.log(`[classifyBookmarks] 发起 API 请求 (${apiProvider})...`);
        const batchResult = await callAIClassifyAPI(
          batch,
          apiProvider,
          apiKey,
          apiBaseUrl
        );
        
          console.log(`[classifyBookmarks] API 响应接收:`, {
              hasResult: !!batchResult,
              foldersCount: batchResult?.folders?.length || 0,
              sampleFolders: batchResult?.folders?.slice(0, 2) || []
          });

        if (batchResult && batchResult.folders) {
          allFolders.push(...batchResult.folders);
            console.log(`[classifyBookmarks] 批次 ${batchNumber} 完成，获得 ${batchResult.folders.length} 个分类建议`);
        } else {
            console.warn(`[classifyBookmarks] 批次 ${batchNumber} 未返回有效结果`);
        }
        
        processedCount += batch.length;
        
        // 滑动窗口：下一个窗口的起始位置
        windowStart += (BATCH_SIZE - WINDOW_OVERLAP);
        
        // 频率限制：根据 API 提供商设置不同的延迟
        const delay = apiProvider === 'gemini' ? 1000 : 800; // Gemini 稍慢一些
          if (windowStart < validBookmarks.length) {
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      } catch (error) {
          console.error(`[classifyBookmarks] 批次处理错误 (${windowStart}-${windowEnd}):`, {
              error: error.message,
              stack: error.stack,
              batchNumber,
              batchSize: batch.length
          });
        // 如果单个批次失败，继续处理下一批次
        windowStart += (BATCH_SIZE - WINDOW_OVERLAP);
        // 增加延迟，避免连续失败
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
      console.log(`[classifyBookmarks] 所有批次处理完成，共获得 ${allFolders.length} 个分类建议`);

      // 检查是否有任何成功的批次
      if (allFolders.length === 0) {
          const errorMsg = '所有批次都失败了，请检查 API 配置和网络连接。如果使用 Gemini API，请确保使用正确的模型名称（gemini-1.5-flash 或 gemini-1.5-pro）。';
          console.error('[classifyBookmarks]', errorMsg);
          throw new Error(errorMsg);
      }

    // 合并相同文件夹的建议
      console.log('[classifyBookmarks] 开始合并文件夹建议...');
    const mergedFolders = mergeFolderSuggestions(allFolders);
      console.log(`[classifyBookmarks] 合并完成，最终 ${mergedFolders.length} 个分类:`,
          mergedFolders.map(f => ({ folder: f.folder, count: f.bookmarks?.length || 0 }))
      );
    
    sendClassifyProgress('分类分析完成！');
    
    return {
      folders: mergedFolders,
        totalBookmarks: validBookmarks.length,
      processedCount: processedCount
    };
  } catch (error) {
      console.error('[classifyBookmarks] 分类过程发生错误:', {
          error: error.message,
          stack: error.stack,
          bookmarksCount: validBookmarks?.length || 0
      });
      throw error;
  }
}

// 调用 AI API（支持 Gemini 和智谱 AI）
async function callAIClassifyAPI(bookmarks, provider, apiKey, baseUrl) {
    console.log('[callAIClassifyAPI] ========== API 调用拦截器 ==========');
    console.log('[callAIClassifyAPI] 开始构建 Prompt...');
    const prompt = buildClassificationPrompt(bookmarks);
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

// 调用智谱 AI API
async function callZhipuAPI(bookmarks, prompt, apiKey, baseUrl) {
  const apiUrl = baseUrl || 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
  
    console.log('[callZhipuAPI] 请求 URL:', apiUrl);
    console.log('[callZhipuAPI] 请求体大小:', JSON.stringify({
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
    }).length, '字节');

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
  
    console.log('[callZhipuAPI] 响应状态:', response.status, response.statusText);

    if (!response.ok) {
        const errorText = await response.text();
        console.error('[callZhipuAPI] ========== API 错误响应 ==========');
        console.error('[callZhipuAPI] 状态码:', response.status);
        console.error('[callZhipuAPI] 状态文本:', response.statusText);
        console.error('[callZhipuAPI] 错误响应体:', errorText);
        console.error('[callZhipuAPI] 可能的原因:');
        if (response.status === 401 || response.status === 403) {
            console.error('  - API Key 无效或已过期');
        } else if (response.status === 429) {
            console.error('  - API 调用频率超限');
        } else if (response.status === 402 || response.status === 403) {
            console.error('  - 账户欠费或配额不足');
        } else if (response.status >= 500) {
            console.error('  - 服务器错误，可能是网络问题');
        }
        throw new Error(`智谱 AI API 错误: ${response.status} - ${errorText}`);
    }
  
  const data = await response.json();
    console.log('[callZhipuAPI] 响应数据结构:', {
        hasChoices: !!data.choices,
        choicesCount: data.choices?.length || 0,
        hasMessage: !!(data.choices?.[0]?.message)
    });
  
  // 提取响应文本
  let responseText = '';
  if (data.choices && data.choices[0] && data.choices[0].message) {
    responseText = data.choices[0].message.content;
      console.log('[callZhipuAPI] 响应文本长度:', responseText.length, '字符');
      console.log('[callZhipuAPI] 响应文本预览:', responseText.substring(0, 300));
  } else {
      console.warn('[callZhipuAPI] 响应中未找到有效内容:', data);
  }
  
  return parseAIResponse(responseText, bookmarks);
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
