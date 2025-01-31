import { Context, h, Random, Schema, Session } from "koishi";
import { } from "koishi-plugin-adapter-onebot";
import { } from "koishi-plugin-cache-database";

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
            "新人入群提醒信息 使用{ @at }艾特新人<br> 可选变量: formula: 化学式, vCodeExp: 验证码有效期, attempts: 剩余尝试次数"
        )
        .default(
            "欢迎{ @at } 加入本群！请完成群验证。\n{ formula } 的相对分子质量？ \n有效期为：{ vCodeExp } 秒，请在有效期内完成验证\n (tips: 你只有{ attempts }次机会，超过{ attempts }次将被移出本群)"
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


const FORMULAS = [
    { formula: "H₂O", mass: 18 },       // 水
    { formula: "CO₂", mass: 44 },       // 二氧化碳
    { formula: "CH₄", mass: 16 },       // 甲烷
    { formula: "NH₃", mass: 17 },       // 氨气
    { formula: "O₂", mass: 32 },        // 氧气
    { formula: "NaCl", mass: 58 },      // 氯化钠
    { formula: "C₁₂H₂₂O₁₁", mass: 342 }, // 蔗糖
    { formula: "H₂SO₄", mass: 98 },     // 硫酸
    { formula: "Fe₃O₄", mass: 232 },    // 四氧化三铁
    { formula: "CuO", mass: 80 },       // 氧化铜
    { formula: "Cu₂O", mass: 144 },     // 氧化亚铜

    { formula: "HCl", mass: 36 },       // 盐酸
    { formula: "HNO₃", mass: 63 },      // 硝酸
    { formula: "NaOH", mass: 40 },      // 氢氧化钠
    { formula: "CaCO₃", mass: 100 },    // 碳酸钙
    { formula: "H₂O₂", mass: 34 },      // 过氧化氢
    { formula: "C₆H₁₂O₆", mass: 180 },  // 葡萄糖
    { formula: "C₂H₄O₂", mass: 60 },    // 乙酸
    { formula: "CaO", mass: 56 },       // 氧化钙
    { formula: "MgO", mass: 40 },       // 氧化镁
    { formula: "Al₂O₃", mass: 102 },    // 氧化铝
    { formula: "SO₂", mass: 64 },       // 二氧化硫
    { formula: "SO₃", mass: 80 },       // 三氧化硫
    { formula: "NO₂", mass: 46 },       // 二氧化氮
    { formula: "N₂O", mass: 44 },       // 一氧化二氮
    { formula: "KCl", mass: 74 },       // 氯化钾
    { formula: "H₂S", mass: 34 },       // 硫化氢
    { formula: "CH₃OH", mass: 32 },     // 甲醇
    { formula: "C₂H₅OH", mass: 46 },    // 乙醇
    { formula: "H₃PO₄", mass: 98 },     // 磷酸
    { formula: "Ca(OH)₂", mass: 74 },   // 氢氧化钙
    { formula: "BaSO₄", mass: 233 },    // 硫酸钡
    { formula: "Pb(NO₃)₂", mass: 331 }, // 硝酸铅
    { formula: "NH₄NO₃", mass: 80 },    // 硝酸铵
    { formula: "Mg(OH)₂", mass: 58 },   // 氢氧化镁
    { formula: "Al(OH)₃", mass: 78 },   // 氢氧化铝
    { formula: "FeS₂", mass: 120 },     // 二硫化亚铁
    { formula: "C₃H₈", mass: 44 },      // 丙烷
    { formula: "C₄H₁₀", mass: 58 },     // 丁烷
    { formula: "HCN", mass: 27 },       // 氰化氢
];

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
    args: { userId?: string;[x: string]: any }
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

        const { formula, mass } = FORMULAS[Random.int(0, FORMULAS.length)];

        ctx.logger.info(guildId, userId, type);

        try {
            const args = {
                userId,
                formula,
                attempts,
                vCodeExp: (vCodeExp / 1000).toFixed(0),
            };

            await session.send(
                parseMsgToJSX(config.groupNewMemberVerificationMessage, args)
            );

            const value: CaptchaCache = {
                attempts: 0,
                result: mass,
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

        if (captchaCache.result < Number(content) + 1 && captchaCache.result < Number(content) - 1) {
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