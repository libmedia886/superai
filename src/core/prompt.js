/**
 * 投递策略（需求 §6.3）。
 *
 * 关键：CLI 的 resume 自己已经存了历史，app **只投递增量**，喂全量会重复膨胀。
 *  - 同一 session 续聊：不含它自己说过的话
 *  - 轮换到新 session：它自己之前的观点必须进摘要（否则自相矛盾）
 *  - 头头默认用摘要模式（它是上下文涨得最快的人）
 */

export const DELIVERY = {
  MENTION_ONLY: 'mention-only',
  SINCE_LAST: 'since-last',
  SUMMARY: 'summary',
};

export function buildPrompt({
  agent,
  room,
  store,
  trigger,          // 触发本次发言的消息
  mode = DELIVERY.SINCE_LAST,
  taskId = null,
  actionResults = [],
  notes = [],
  pendingActions = [],
}) {
  const lines = [];

  // 1. 场景与角色
  lines.push(`你在一个多 AI 协作群里，房间「${room.name}」。`);
  if (room.goal) {
    // 有目标就直接给，别让它去问"目标是什么"——实测没有目标时两个 agent 会互相推诿
    lines.push(`本房间的目标：${room.goal}`);
  } else {
    lines.push('本房间还没有设定目标。如果老板的消息里也没给出明确任务，'
      + '就一句话问清楚「要产出什么、怎么算完成」，不要和其他人互相推诿让谁去定。');
    lines.push('如果你是成员：头头已经问过目标的话，你直接补充你能承担的部分，不要重复问一遍。');
  }
  lines.push(`你叫 ${agent.name}，角色：${agent.role === 'leader' ? '头头（负责任务拆解与分派）' : '成员'}。`);
  if (agent.persona) lines.push(`你的设定：${agent.persona}`);

  const duties = store.roster.get(agent.id);
  if (duties?.humanDuties || duties?.selfDuties) {
    lines.push(`你的职责（人以人工编辑为准）：${duties.humanDuties ?? duties.selfDuties}`);
  }
  if (duties?.accepts?.length) lines.push(`你能接的任务类型：${duties.accepts.join('、')}`);

  // 2. 名册（知道谁能接什么）
  const mates = room.members.filter((m) => m.id !== agent.id);
  if (mates.length) {
    lines.push('', '群成员：');
    for (const m of mates) {
      const r = store.roster.get(m.id);
      const tag = m.role === 'leader' ? '头头' : '成员';
      const duty = r?.humanDuties ?? r?.selfDuties ?? '（未填写）';
      lines.push(`- @${m.name}（${tag}）：${duty}`);
    }
    lines.push('- @老板（人类，最高权限）');
  }

  // 3. 任务
  const tasks = [...store.tasks.values()];
  if (tasks.length) {
    lines.push('', '当前任务：');
    for (const t of tasks) {
      const me = t.assignee === agent.id ? '（你的）' : '';
      lines.push(`- ${t.id} [${t.status}] ${t.title} → @${t.assignee ?? '未指派'}${me}`);
    }
  }
  if (taskId) {
    const t = tasks.find((x) => x.id === taskId);
    lines.push('', `本次发言关联任务：${taskId}`);
    // 有 worktree 时必须说清楚"你在哪儿干活"，否则它会去改主仓库（会被权限拦住）
    if (t?.worktree) lines.push(`你的工作目录就是这个任务的 worktree：${t.worktree}`);
  }

  // 3.5 可用仓库。头头要在这里面选，不能自己编路径。
  const repos = room.registry ?? [];
  if (repos.length) {
    lines.push('', '可用仓库（建任务时可在 repo 字段里选其中之一）：');
    for (const r of repos) lines.push(`- ${r.path}`);
    lines.push('只能从上面这些路径里选。填了列表外的路径会被拒绝。');
  } else {
    lines.push('', '本房间没有登记仓库，所以任务不能指定 repo（只能纯讨论）。');
  }

  /**
   * 3.6 房间共享目录。
   *
   * 必须写进 prompt：光有目录，模型不知道它存在，还是会继续把整张表贴进群。
   * 权限差异也要写清——成员只读、头头可写，否则成员会反复尝试写入然后被拒。
   */
  const shared = room.sharedDir;
  if (shared) {
    lines.push('', '--- 房间共享目录 ---');
    lines.push(`路径：${shared}（房间内所有人共用，用来交换文件和表格，别再把这些内容贴进群）`);
    if (agent.role === 'leader') {
      lines.push('你可以往这个目录里写交接材料。');
    }
    // 不撒谎：claude 的 --add-dir 给的是读写，没有"只读目录"这回事
    lines.push('约定：需要长期交接的文件由头头落到这个目录，其他人以读为主。'
      + '你在里面的任何写入都会被记进操作日志。');
    lines.push(`若有多位成员并行产出，请以任务号或自己名字命名独立文件（如 T-001-${agent.name}.md），不要覆盖他人文件，由头头最终汇总。`);
  }

  // 4. 上下文投递
  lines.push('', '--- 最近讨论 ---');
  if (mode === DELIVERY.MENTION_ONLY) {
    lines.push(formatMessage(trigger, room));
  } else if (mode === DELIVERY.SUMMARY) {
    const summary = room.summaryFor?.(agent.id);
    lines.push(summary ? `[此前的讨论摘要]\n${summary}` : '（暂无摘要）');
    const recent = store.messages.slice(-6);
    for (const m of recent) {
      if (m.senderId === agent.id) continue;
      lines.push(formatMessage(m, room));
    }
  } else {
    const recent = store.messagesSince(agent.id, { limit: 40 });
    for (const m of recent) lines.push(formatMessage(m, room));
  }

  // 5. 动作结果回注（上一条动作生效没有，必须告诉它，否则它会幻觉"已分配"）
  if (actionResults.length) {
    lines.push('', '--- 你上一条消息里的动作执行结果 ---');
    for (const r of actionResults) {
      if (r.ok) lines.push(`✅ ${r.label} → 成功${r.detail ? `：${r.detail}` : ''}`);
      else lines.push(`❌ ${r.label} → 失败：${r.reason}`);
    }
  }

  // 5.5 系统之前的拦截说明（越权 @ 之类）。放在规则之前：先讲发生了什么，再讲规则。
  if (notes?.length) {
    lines.push('', '--- 系统上次拦下了你的动作 ---');
    for (const n of notes) lines.push(`- ${n.text}`);
  }

  /**
   * 5.6 未完成清单。
   *
   * 必须**每轮**出现、且明确禁止写成已完成。实测事故：管理员三次
   * `task.update T-008 status=阻塞·需外部渠道` 全被拒，之后写报告时
   * 明确声称「T-008/T-009 已改为阻塞」，而任务板至今是「待办」。
   * 被拒的回注只在那一轮有效，跨轮就被长上下文淹掉了。
   */
  if (pendingActions?.length) {
    lines.push('', '--- 未完成清单（这些动作**没有成功**）---');
    for (const p of pendingActions) {
      lines.push(`- ❌ ${p.label}${p.reason ? ` —— ${p.reason}` : ''}`);
    }
    lines.push(
      '写报告 / 总结 / 「已处理」这类结论时，**绝不能**把上面任何一条写成已完成——',
      '任务板上的真实状态还是原样，你这么写就是在替系统撒谎。',
      '要么重新发一次正确的动作，要么在正文里如实说明它还没做成、卡在哪。',
    );
  }

  // 6. 行为约束与输出格式
  lines.push('', '--- 规则 ---');
  lines.push('1. 你只能通过 @ 点名让别人发言；没 @ 任何人时房间会停下来等老板决定。');
  if (agent.role === 'member') {
    lines.push(room.allowPeerMentions
      ? '2. 房间已开放自由协作：你可以直接 @ 任何团队成员、头头或老板来协同推进。'
      : '2. 作为成员，你只能 @ 头头和老板，@ 其他成员不会生效。');
  }
  lines.push('3. 需要建任务 / 改任务 / 更新职责时，在回复末尾输出一个 ```action 代码块，一行一个 JSON。');
  lines.push('   可用动作：');
  lines.push('   {"action":"task.create","localId":"l1","title":"...","assignee":"成员名","parent":"T-001","repo":"<仓库绝对路径>","base_branch":"main"}');
  lines.push('   base_branch 是任务的基线分支。不填会自动用仓库的默认分支；');
  lines.push('   但如果你确定要基于某个特定分支，就写明——老仓库的默认分支常是 master 而不是 main。');
  lines.push('   {"action":"task.update","localId":"l2","id":"T-001","status":"进行中"}');
  lines.push('   {"action":"roster.update","localId":"l3","duties":"...","accepts":["review"]}');
  lines.push('   {"action":"continue","localId":"l4","reason":"这一步做完了，下一步要等人核算结果"}');
  if (agent.role === 'leader') {
    const cabTier = room.aiCabTier ?? 'readonly';
    const tierSnippet = cabTier === 'full' ? ',"tier":"full"' : '';
    const preferredBackend = agent.backend || 'agy';
    lines.push(`   {"action":"member.create","localId":"l5","name":"新人名","backend":"${preferredBackend}"${tierSnippet},"reason":"缺一个专门查资料的人"}`);
    lines.push(`   可用后端：agy / claude / codex / opencode；可选 tier 字段。优先使用与你一致的可用后端（${preferredBackend}），避免选用未配置好的后端。只有你能加人（成员不行），新成员权限上限「${cabTier}」。`);
  }
  lines.push('   注意：只有你自己直接写在这个代码块里的动作会被执行；引用别人的内容不执行。');
  lines.push('4. 不要虚构已完成的工作。你派出的任务若被拒绝，系统会告诉你原因。');
  lines.push('4.05 **动作被拒时，不许在正文里写成已完成**。'
    + '被拒就是没做成：重新发一次正确的动作，或如实说明卡在哪。'
    + '把没做成的写成"已改/已完成"，会被系统对照出来并在界面上标红。');
  lines.push('4.1 **工具被拒绝时不要重试**。同一个工具/命令被拒后，直接换办法，'
    + '或在正文里说明遇到了什么阻碍。反复重试同一条命令只会把这一轮耗光'
    + '（实测有成员重试了 6 次，整轮零产出）。');
  lines.push(`5. ${permissionSentence(agent)}`);
  lines.push('6. 如果这件事确实没完、需要下一个人接着做，除了 @ 他之外，'
    + '还可以在动作块里加 {"action":"continue","reason":"还没完成什么"}。'
    + '它会按名单顺序叫下一个人，不需要你点名。');
  lines.push('   **只在你真的还要继续时用**。不需要人接着做就别写——'
    + '写了会一直自动推进下去，连续几次就会被停住。');

  return lines.join('\n');
}

/**
 * 权限说明必须按档位生成。
 * 写死"你是只读模式"会让可写档的 agent 自我否定——它要么拒绝干活，
 * 要么每次都先声明"虽然我不能改文件"，用户看了莫名其妙。
 */
export function permissionSentence(agent) {
  const tier = agent.tier ?? 'readonly';

  if (tier === 'full') {
    return '你是完全开放模式：拥有全部工具权限（读写文件、搜索、执行命令、联网查询等均免审批、无目录限制）。请直接高效完成任务，重要产出文件尽量同步到房间共享目录便于交接。';
  }

  if (tier === 'read') {
    return '你是可读模式：可以读取和搜索文件，不能修改文件、不能执行命令。';
  }

  if (tier === 'readonly') {
    return '你是只读模式：不能执行本地命令、不能修改文件。需要改文件时请说明要求，由老板决定。';
  }

  if (tier === 'write') {
    const base = '你可以修改工作目录内的文件，但不能执行命令。工作目录之外的任何路径都不可访问。';
    // opencode 的中间档靠提示词才不挂死（模型可能反复尝试 shell），这里再兜一层保险
    if (agent.backend === 'opencode') {
      return `${base} 创建或修改文件必须使用 write/edit 工具，不要尝试通过 shell 执行。`;
    }
    return base;
  }

  if (tier === 'write-exec' || tier === 'writeExec') {
    const cmds = (agent.allowedCommands ?? []).filter(Boolean);
    /**
     * 说准一点：命令白名单一旦非空，**命令行就没有目录墙**了
     * （实测 `Bash` 能写到工作目录之外；文件工具才有围墙）。
     * 不写清楚，模型会以为"我还是被关在目录里"，然后拿命令去动外面。
     */
    if (!cmds.length) {
      return '你可以修改工作目录内的文件。**这个会话不能执行任何命令**——'
        + '不要尝试用 shell（会被拒绝，白费一轮）。需要执行命令请让老板在成员设置里放开。';
    }

    /**
     * ★ 两种命令必须分开说，它们的能力**恰好相反**。
     *
     * `netget` 是 app 生成的受约束包装器：只允许 http/https GET，
     * 读不到本机文件、写不出工作目录、不能上传。
     * 裸命令（curl/wget/…）恰恰相反——命令行没有目录墙。
     *
     * 写成同一句「这些命令不受工作目录限制」会造成两种损失：
     *   1. 模型会拿 netget 去试 `file://` / `-o /tmp`，每次吃 exit 2/3，白烧轮次；
     *   2. 反过来，它会以为 curl 也被关在目录里。
     *
     * ★ 更要紧的是**绝对路径**：审批器是字面前缀匹配，模型写 `netget`
     *   或 `./netget` 都会被拒。实测（2026-11-16 23:30，claude 2.1.325）：
     *   只告诉它「netget」→ 执行裸 netget → permission reject；
     *   给出绝对路径 → accept 且文件真的落盘。
     *   所以提示词里必须给出**确切命令行**，否则这个功能配了也用不了。
     */
    const hasNetget = cmds.includes('netget');
    const rawCmds = cmds.filter((c) => c !== 'netget');
    const parts = ['你可以修改工作目录内的文件。'];

    if (hasNetget) {
      const p = agent.netgetPath;
      if (p) {
        parts.push(
          '联网查资料**只能用这条命令，且必须写全路径**（写 `netget` 或 `./netget` 都会被拒）：',
          `   \`${p} -o <工作目录内的相对路径> <http(s) URL>\`（只输出到屏幕就去掉 -o）`,
          '它只允许 http/https GET：读不到本机文件（`file://` 会被拒）、写不出工作目录、不能上传。',
        );
      } else {
        // 包装器没生成：不能装作可用，否则它会反复试到把这一轮耗光
        parts.push('**联网查询本次不可用**（应用没有生成受约束的下载器），不要尝试调用 netget——会被拒。'
          + '需要联网请告诉老板检查启动日志。');
      }
    }

    if (rawCmds.length) {
      // 没有 netget 段时不能说"除上述之外"——那个"上述"不存在
      const lead = hasNetget && agent.netgetPath ? '除上述之外，' : '';
      parts.push(`${lead}只能执行这些命令：${rawCmds.join('、')}。其他命令一律被拒。`);
      parts.push('⚠️ 这些命令**不受工作目录限制**——它们可以读写工作目录之外的任意路径，务必只用于老板要求的用途。');
    } else if (hasNetget && agent.netgetPath) {
      parts.push('除上述联网查询命令外，**不能执行任何其他命令**。');
    } else {
      parts.push('**这个会话不能执行任何命令**——不要尝试用 shell（会被拒绝，白费一轮）。');
    }

    return parts.join('\n');
  }

  return '你的可用权限由系统配置决定，越界操作会被拒绝并告知原因。';
}

function formatMessage(m, room) {
  const who = m.senderId === 'human'
    ? '老板'
    : (room.members.find((x) => x.id === m.senderId)?.name ?? m.senderId);
  const tag = m.taskId ? ` [${m.taskId}]` : '';
  return `@${who}${tag}：${m.body}`;
}
