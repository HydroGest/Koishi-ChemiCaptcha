import { Context, h, Random, Schema, Session } from "koishi";
import {} from "koishi-plugin-adapter-onebot";
import {} from "koishi-plugin-cache-database";

export const name = "captcha";

export const inject = {
  required: ["cache"],
};

export interface Config {
  vCodeExp: number;
  // 白名单群号配置
  attempts: number;
  groupNewMemberVerificationMessage: string;
  groupChatVerificationTimeoutMsg: string;
  humanVerificationSuccessMessage: string;
  humanVerificationFailedKickMessage: string;
  humanVerificationAnswerFailedMessage: string;
}

export const Config: Schema<Config> = Schema.object({
  vCodeExp: Schema.number()
    .default(1000 * 60 * 3)
    .description("验证码有效时间(毫秒)"),
  attempts: Schema.number()
    .default(3)
    .description("最大尝试次数")
    .min(1)
    .max(9),
  groupNewMemberVerificationMessage: Schema.string()
    .role("textarea", { rows: [2, 10] })
    .description(
      "新人入群提醒信息 使用{ @at }艾特新人<br> 可选变量: calcVal1: 随机数1, calcVal2: 随机数2, vCodeExp: 验证码有效期, attempts: 剩余尝试次数"
    )
    .default(
      "欢迎{ @at } 加入本群！请完成群验证。\n{ calcVal1 } + { calcVal2 } = ?\n有效期为：{ vCodeExp } 秒，请在有效期内完成验证\n (tips: 你只有{ attempts }次机会，超过{ attempts }次将被移出本群)"
    ),
  groupChatVerificationTimeoutMsg: Schema.string()
    .role("textarea", { rows: [2, 10] })
    .default("{ @at } 验证超时，你已被移出本群")
    .description("验证超时信息 使用{ @at }艾特新人"),
  humanVerificationSuccessMessage: Schema.string()
    .role("textarea", { rows: [2, 10] })
    .default(
      "{ @at } 验证成功，欢迎加入本群！\n 请遵守群规，文明发言\n 进群可先查看群公告"
    )
    .description("验证成功信息 使用{ @at }艾特新人"),
  humanVerificationFailedKickMessage: Schema.string()
    .role("textarea", {
      rows: [2, 10],
    })
    .default("{ @at } 验证失败，失败次数达到上限，你已被移出本群")
    .description("验证失败信息 使用{ @at }艾特新人"),
  humanVerificationAnswerFailedMessage: Schema.string()
    .role("textarea", { rows: [2, 10] })
    .default("{ @at } 验证失败，你还有{ attempts }次机会")
    .description(
      "验证码错误信息 使用{ @at }艾特新人<br> 可选变量: attempts: 剩余尝试次数"
    ),
});

interface CaptchaCache {
  attempts: number;
  result: number;
  createdAt: number;
  timerId: number;
}

function isUndefined(value: any): boolean {
  return typeof value === "undefined";
}

let timerCounter = 0; // 用于生成唯一的定时器 ID
const timers = {}; // 用于存储定时器对象

function createTimer(callback: Function, delay: number): number {
  const timerId = ++timerCounter; // 生成唯一的定时器 ID
  const timeout = setTimeout(() => {
    callback();
    delete timers[timerId]; // 定时器触发后从对象中删除
  }, delay);

  timers[timerId] = timeout; // 存储定时器对象
  return timerId;
}

function clearTimer(timerId: number) {
  const timeout = timers[timerId];
  if (timeout) {
    clearTimeout(timeout); // 清除定时器
    delete timers[timerId]; // 从对象中删除
  }
}

/**
 * 解析配置提示信息文本，转为JSX
 * @param msg 配置提示信息文本
 */
function parseMsgToJSX(
  msg: string,
  args: { userId?: string; [x: string]: any }
): h[] {
  msg = msg.replaceAll(/\{\s*(\@at)\s*\}+/g, `<at id="${args["userId"]}"/>`);

  const valMatchs = [...msg.matchAll(/\{\s*(\w+)\s*\}+/g)];
  for (const match of valMatchs) {
    // 如果配置参数不存在，则跳过 可有效避免报错或返回undefined的情况
    if (isUndefined(args[match[1]])) {
      continue;
    }
    msg = msg.replace(match[0], args[match[1]]);
  }

  return h.parse(msg);
}

export function apply(ctx: Context, config: Config) {
  // write your plugin here

  ctx.on("ready", () => {
    ctx.logger.info("captcha plugin loaded");
  });

  ctx.on("guild-member-added", async (session: Session) => {
    const { userId, guildId, type } = session;
    const { vCodeExp, attempts } = config;

    const calcVal1 = Random.int(1, 100);
    const calcVal2 = Random.int(1, 100);

    ctx.logger.info(guildId, userId, type);

    try {
      const args = {
        userId,
        calcVal1,
        calcVal2,
        attempts,
        vCodeExp: (vCodeExp / 1000).toFixed(0),
      };

      await session.send(
        parseMsgToJSX(config.groupNewMemberVerificationMessage, args)
      );

      const value: CaptchaCache = {
        attempts: 0,
        result: calcVal1 + calcVal2,
        createdAt: Date.now(),
        timerId: createTimer(async () => {
          const captchaCache: CaptchaCache | undefined = await ctx.cache.get(
            "default",
            `captcha:${userId}`
          );

          ctx.logger.info("验证码超时，移出群 " + userId);
          await session.send(
            parseMsgToJSX(config.groupChatVerificationTimeoutMsg, { userId })
          );
          session.onebot.setGroupKick(guildId, userId, false);
        }, vCodeExp),
      };
      await ctx.cache.set("default", `captcha:${userId}`, value, vCodeExp);
    } catch (error) {
      ctx.logger.error(error);
      session.send("入群验证码插件出错, 请联系管理员");
    }
  });

  ctx.on("guild-member-removed", async (session: Session) => {
    // 如果待验证群员被移除群或退出群，则删除定时器缓存
    // 识别成员退出需管理员权限
    const { userId } = session;

    let captchaCache: CaptchaCache | undefined;
    captchaCache = await ctx.cache.get("default", `captcha:${userId}`);
    if (isUndefined(userId) || isUndefined(captchaCache)) {
      return;
    } else {
      ctx.logger.info(
        "captcha plugin: 识别到待验证群员被移除群或退出群，清除定时器 && 删除缓存"
      );
      return Promise.all([
        clearTimer(captchaCache.timerId),
        ctx.cache.delete("default", `captcha:${userId}`),
      ]);
    }
  });

  ctx.on("message-created", async (session: Session) => {
    const { userId, guildId, messageId } = session;
    const message = session.event.message;
    const { content } = message;
    const { attempts } = config;

    let captchaCache: CaptchaCache | undefined;
    try {
      captchaCache = await ctx.cache.get("default", `captcha:${userId}`);
      await ctx.cache.delete("default", `captcha:${userId}`);
    } catch (error) {
      ctx.logger.error(error);
    }

    if (
      isUndefined(guildId) ||
      isUndefined(content) ||
      isUndefined(captchaCache)
    )
      return;

    if (captchaCache.result === Number(content)) {
      clearTimer(captchaCache.timerId);
      await session.send(
        parseMsgToJSX(config.humanVerificationSuccessMessage, { userId })
      );

      await ctx.cache.delete("default", `captcha:${userId}`);
    } else {
      // 撤回未验证群员的消息

      captchaCache.attempts++;

      if (captchaCache.attempts >= attempts) {
        // 验证超过上限，移除本群
        clearTimer(captchaCache.timerId);
        await session.send(
          parseMsgToJSX(config.humanVerificationFailedKickMessage, { userId })
        );

        session.onebot?.setGroupKick(guildId, userId, false);
      } else {
        const vCodeExp: number = Date.now() - captchaCache.createdAt;

        Promise.all([
          ctx.cache.set("default", `captcha:${userId}`, captchaCache, vCodeExp),
          session.send(
            parseMsgToJSX(config.humanVerificationAnswerFailedMessage, {
              attempts: attempts - captchaCache.attempts,
              userId,
            })
          ),
          session.onebot.deleteMsg(messageId),
        ]);
      }
    }
  });
}
