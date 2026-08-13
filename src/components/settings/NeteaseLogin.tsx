import {
  useState,
  useRef,
  useCallback,
  useEffect,
  type FormEvent,
} from "react";
import {
  User,
  RefreshCw,
  Check,
  Loader2,
  ScanLine,
  Download,
  LogOut,
  KeyRound,
  Smartphone,
} from "lucide-react";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { SettingItem } from "./SettingItem";
import {
  checkQrStatus,
  getNeteaseSession,
  getQrKey,
  logoutNeteaseSession,
  loginCellphone,
} from "@/lib/netease/netease-api";
import type { UserProfile } from "@/lib/netease/netease-types";
import toast from "react-hot-toast";
import { QRCodeCanvas } from "qrcode.react";
import { useNeteaseStore } from "@/store/netease-store";
import { clearMarketSession } from "@/store/session/market-session";
import { saveQrCanvasAsPng } from "@/lib/netease/qr-download";

const STATUS_MESSAGES = {
  loading: "正在获取二维码...",
  waiting: "请使用网易云音乐扫码",
  scanned: "扫描成功，请在网易云音乐中确认",
  expired: "二维码已过期",
  success: "登录成功，同步中...",
} as const;

type QrStatus = keyof typeof STATUS_MESSAGES;
type LoginMode = "cellphone" | "qr";

interface AccountOperationOwner {
  generation: number;
  controller: AbortController;
}

export function NeteaseLogin() {
  const { user, authenticated, setSession, clearSession } = useNeteaseStore();
  const [showLoginDialog, setShowLoginDialog] = useState(false);
  const [showUserDrawer, setShowUserDrawer] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [qrUrl, setQrUrl] = useState("");
  const [qrStatus, setQrStatus] = useState<QrStatus>("loading");
  const [loginMode, setLoginMode] = useState<LoginMode>("cellphone");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");

  const qrCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const operationRef = useRef<{
    generation: number;
    controller: AbortController | null;
  }>({ generation: 0, controller: null });
  const pollStatusRef = useRef<
    (key: string, owner: AccountOperationOwner) => Promise<void>
  >(async () => {});

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const isOwner = useCallback((owner: AccountOperationOwner) => {
    const current = operationRef.current;
    return (
      !owner.controller.signal.aborted &&
      current.generation === owner.generation &&
      current.controller === owner.controller
    );
  }, []);

  const invalidateOwner = useCallback(
    (expected?: AccountOperationOwner) => {
      if (expected && !isOwner(expected)) return;
      clearTimer();
      operationRef.current.controller?.abort();
      operationRef.current = {
        generation: operationRef.current.generation + 1,
        controller: null,
      };
    },
    [clearTimer, isOwner]
  );

  const beginOperation = useCallback((): AccountOperationOwner => {
    clearTimer();
    operationRef.current.controller?.abort();
    const owner = {
      generation: operationRef.current.generation + 1,
      controller: new AbortController(),
    };
    operationRef.current = owner;
    return owner;
  }, [clearTimer]);

  const resetDialogState = useCallback(() => {
    clearTimer();
    setQrUrl("");
    setQrStatus("loading");
    setLoading(false);
  }, [clearTimer]);

  const onLoginSuccess = useCallback(
    async (owner: AccountOperationOwner, profile: UserProfile) => {
      if (!isOwner(owner)) return;
      await clearMarketSession();
      if (!isOwner(owner)) return;
      setSession(profile);
      invalidateOwner(owner);
      setShowLoginDialog(false);
      setPassword("");
      resetDialogState();
      toast.success("网易云登录成功");
    },
    [invalidateOwner, isOwner, resetDialogState, setSession]
  );

  const scheduleNextPoll = useCallback(
    (key: string, owner: AccountOperationOwner) => {
      if (!isOwner(owner)) return;
      timerRef.current = setTimeout(() => {
        void pollStatusRef.current(key, owner);
      }, 1600);
    },
    [isOwner]
  );

  const pollStatus = useCallback(
    async (key: string, owner: AccountOperationOwner) => {
      if (!isOwner(owner)) return;
      try {
        const { code, profile, message } = await checkQrStatus(
          key,
          owner.controller.signal
        );
        if (!isOwner(owner)) return;

        switch (code) {
          case 800:
          case 8821:
            setQrStatus("expired");
            clearTimer();
            if (code === 8821) toast.error(message || "登录环境异常");
            return;
          case 801:
            setQrStatus("waiting");
            scheduleNextPoll(key, owner);
            return;
          case 802:
            setQrStatus("scanned");
            scheduleNextPoll(key, owner);
            return;
          case 803:
            setQrStatus("success");
            clearTimer();
            if (!profile) {
              toast.error("服务端未返回用户信息，请刷新二维码重试");
              return;
            }
            await onLoginSuccess(owner, profile);
            return;
          default:
            scheduleNextPoll(key, owner);
        }
      } catch (error) {
        if (
          isOwner(owner) &&
          !(error instanceof Error && error.name === "AbortError")
        ) {
          scheduleNextPoll(key, owner);
        }
      }
    },
    [clearTimer, isOwner, onLoginSuccess, scheduleNextPoll]
  );

  useEffect(() => {
    pollStatusRef.current = pollStatus;
  }, [pollStatus]);

  const fetchQrCode = useCallback(
    async (owner: AccountOperationOwner) => {
      if (!isOwner(owner)) return;
      setLoading(true);
      setQrStatus("loading");
      setQrUrl("");

      try {
        const key = await getQrKey(owner.controller.signal);
        if (!isOwner(owner)) return;
        setQrUrl(
          `https://music.163.com/login?codekey=${encodeURIComponent(key)}`
        );
        setQrStatus("waiting");
        void pollStatusRef.current(key, owner);
      } catch (error) {
        if (!isOwner(owner)) return;
        setQrStatus("expired");
        if (!(error instanceof Error && error.name === "AbortError")) {
          toast.error("获取二维码失败");
        }
      } finally {
        if (isOwner(owner)) setLoading(false);
      }
    },
    [isOwner]
  );

  const refreshQrCode = useCallback(() => {
    const owner = beginOperation();
    void fetchQrCode(owner);
  }, [beginOperation, fetchQrCode]);

  useEffect(() => {
    const owner = beginOperation();
    void getNeteaseSession(owner.controller.signal)
      .then((profile) => {
        if (!isOwner(owner)) return;
        if (profile) setSession(profile);
        else clearSession();
      })
      .catch((error: unknown) => {
        if (
          isOwner(owner) &&
          !(error instanceof Error && error.name === "AbortError")
        ) {
          clearSession();
        }
      });
    return () => invalidateOwner(owner);
  }, [beginOperation, clearSession, invalidateOwner, isOwner, setSession]);

  useEffect(() => {
    if (!showLoginDialog || loginMode !== "qr") return;
    const owner = beginOperation();
    void fetchQrCode(owner);
    return () => invalidateOwner(owner);
  }, [
    beginOperation,
    fetchQrCode,
    invalidateOwner,
    loginMode,
    showLoginDialog,
  ]);

  useEffect(() => () => invalidateOwner(), [invalidateOwner]);

  const startLogin = useCallback(() => {
    invalidateOwner();
    resetDialogState();
    setLoginMode("cellphone");
    setShowLoginDialog(true);
  }, [invalidateOwner, resetDialogState]);

  const closeLoginDialog = useCallback(() => {
    invalidateOwner();
    setShowLoginDialog(false);
    setPassword("");
    resetDialogState();
  }, [invalidateOwner, resetDialogState]);

  const handleSaveQr = useCallback(async () => {
    const canvas = qrCanvasRef.current;
    if (!canvas) return;
    if (await saveQrCanvasAsPng(canvas)) {
      toast.success("二维码已保存，可在网易云扫一扫中从相册选择");
    } else {
      toast.error("二维码保存失败");
    }
  }, []);

  const handleCellphoneLogin = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!/^1\d{10}$/.test(phone)) {
        toast.error("请输入正确的 11 位手机号");
        return;
      }
      if (!password) {
        toast.error("请输入网易云密码");
        return;
      }
      const owner = beginOperation();
      setLoading(true);
      try {
        const profile = await loginCellphone(
          phone,
          password,
          owner.controller.signal
        );
        if (!isOwner(owner)) return;
        await onLoginSuccess(owner, profile);
      } catch (error) {
        if (
          isOwner(owner) &&
          !(error instanceof Error && error.name === "AbortError")
        ) {
          toast.error("登录失败，请检查账号密码；遇到网易验证时可改用扫码登录");
        }
      } finally {
        if (isOwner(owner)) setLoading(false);
      }
    },
    [beginOperation, isOwner, onLoginSuccess, password, phone]
  );

  const changeLoginMode = useCallback(
    (value: string) => {
      invalidateOwner();
      resetDialogState();
      setLoginMode(value === "qr" ? "qr" : "cellphone");
    },
    [invalidateOwner, resetDialogState]
  );

  const handleLogout = async () => {
    if (loggingOut) return;
    if (!window.confirm("确定要退出网易云登录吗？")) return;
    const owner = beginOperation();
    setLoggingOut(true);
    try {
      await logoutNeteaseSession(owner.controller.signal);
      if (!isOwner(owner)) return;
      clearSession();
      setLoggingOut(false);
      invalidateOwner(owner);
      setShowUserDrawer(false);
      toast.success("已退出登录");
    } catch (error) {
      if (!isOwner(owner)) return;
      // An HttpOnly cookie cannot be cleared by JavaScript. Keep the UI signed
      // in until the server confirms that both KV and the cookie were revoked.
      if (!(error instanceof Error && error.name === "AbortError")) {
        toast.error("退出失败，请检查网络后重试");
      }
    } finally {
      if (isOwner(owner)) setLoggingOut(false);
    }
  };

  return (
    <>
      <SettingItem
        icon={User}
        title="网易云账号"
        subtitle={authenticated && user ? user.nickname : "登录后可同步歌单"}
        action={
          authenticated && user ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="rounded-full p-0"
              onClick={() => setShowUserDrawer(true)}
              aria-label="打开网易云账号"
            >
              <Avatar className="h-10 w-10 transition-opacity hover:opacity-80">
                <AvatarImage src={user.avatarUrl} />
                <AvatarFallback>{user.nickname?.[0]}</AvatarFallback>
              </Avatar>
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={startLogin}
              disabled={loading}
              className="px-4"
            >
              {loading && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
              登录
            </Button>
          )
        }
      />

      <Drawer
        open={showLoginDialog}
        onOpenChange={(open) => {
          if (open) setShowLoginDialog(true);
          else closeLoginDialog();
        }}
      >
        <DrawerContent className="max-h-[90vh]">
          <DrawerHeader className="mb-2 px-4">
            <DrawerTitle className="text-center text-lg">
              登录网易云音乐
            </DrawerTitle>
            <DrawerDescription className="text-center text-xs">
              手机号密码登录，扫码作为备用方式
            </DrawerDescription>
          </DrawerHeader>

          <Tabs
            value={loginMode}
            onValueChange={changeLoginMode}
            className="overflow-y-auto px-4 pb-6"
          >
            <TabsList className="mx-auto grid w-full max-w-sm grid-cols-2">
              <TabsTrigger value="cellphone">
                <Smartphone />
                手机号
              </TabsTrigger>
              <TabsTrigger value="qr">
                <ScanLine />
                扫码
              </TabsTrigger>
            </TabsList>

            <TabsContent
              value="cellphone"
              className="mx-auto mt-4 w-full max-w-sm"
            >
              <form
                className="space-y-4"
                onSubmit={(event) => void handleCellphoneLogin(event)}
              >
                <div className="space-y-2">
                  <label
                    htmlFor="netease-phone"
                    className="text-sm font-medium"
                  >
                    手机号
                  </label>
                  <Input
                    id="netease-phone"
                    type="tel"
                    inputMode="numeric"
                    autoComplete="tel"
                    value={phone}
                    onChange={(event) =>
                      setPhone(
                        event.target.value.replace(/\D/g, "").slice(0, 11)
                      )
                    }
                    placeholder="11 位手机号"
                    disabled={loading}
                  />
                </div>
                <div className="space-y-2">
                  <label
                    htmlFor="netease-password"
                    className="text-sm font-medium"
                  >
                    密码
                  </label>
                  <Input
                    id="netease-password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="网易云音乐密码"
                    maxLength={256}
                    disabled={loading}
                  />
                </div>
                <Button
                  type="submit"
                  className="h-11 w-full"
                  disabled={loading}
                >
                  {loading ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <KeyRound />
                  )}
                  登录
                </Button>
                <p className="text-center text-[11px] leading-relaxed text-muted-foreground">
                  密码仅用于本次登录请求，不会保存在浏览器；如触发网易安全验证，请切换扫码登录。
                </p>
              </form>
            </TabsContent>

            <TabsContent value="qr" className="mt-4">
              <div className="flex flex-col items-center space-y-4">
                <div className="relative flex h-[180px] w-[180px] items-center justify-center">
                  {qrStatus === "loading" && (
                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground/50" />
                  )}

                  {(qrStatus === "waiting" ||
                    qrStatus === "scanned" ||
                    qrStatus === "success") &&
                    qrUrl && (
                      <div className="h-full w-full rounded-xl bg-white p-2 shadow-sm">
                        <QRCodeCanvas
                          ref={qrCanvasRef}
                          value={qrUrl}
                          size={324}
                          level="M"
                          className="h-full w-full"
                        />
                      </div>
                    )}

                  {qrStatus === "scanned" && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center rounded-xl bg-background/65 backdrop-blur-sm">
                      <Check className="mb-2 h-9 w-9 text-primary" />
                      <span className="text-sm font-medium">已扫码</span>
                      <span className="mt-1 text-[11px] text-muted-foreground">
                        请在网易云音乐中确认
                      </span>
                    </div>
                  )}

                  {qrStatus === "expired" && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center rounded-xl bg-background/80 backdrop-blur-sm">
                      <ScanLine className="mb-3 h-7 w-7 text-muted-foreground/50" />
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={refreshQrCode}
                        className="h-8 rounded-full px-4 text-xs"
                      >
                        <RefreshCw className="mr-1.5 h-3 w-3" />
                        刷新二维码
                      </Button>
                    </div>
                  )}
                </div>

                <div className="space-y-1 text-center">
                  <p className="text-sm font-medium">
                    {STATUS_MESSAGES[qrStatus]}
                  </p>
                  <p className="text-[11px] text-muted-foreground/70">
                    网易凭证在服务端加密保存，浏览器不会接触账号凭证
                  </p>
                </div>

                {qrUrl &&
                  (qrStatus === "waiting" || qrStatus === "scanned") && (
                    <div className="w-full max-w-xs space-y-2 rounded-xl bg-muted/30 p-3 text-center">
                      <p className="text-[11px] leading-relaxed text-muted-foreground">
                        只有这一部手机？先保存二维码，再到网易云音乐“扫一扫”中从相册选择。
                      </p>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="w-full rounded-full"
                        onClick={() => void handleSaveQr()}
                      >
                        <Download className="mr-1.5 h-3.5 w-3.5" />
                        保存二维码图片
                      </Button>
                    </div>
                  )}
              </div>
            </TabsContent>
          </Tabs>
        </DrawerContent>
      </Drawer>

      <Drawer open={showUserDrawer} onOpenChange={setShowUserDrawer}>
        <DrawerContent>
          <DrawerHeader className="mb-2 px-4 text-center">
            <DrawerTitle>{user?.nickname}</DrawerTitle>
            <DrawerDescription>网易云账号已安全连接</DrawerDescription>
          </DrawerHeader>
          <div className="flex flex-col gap-3 px-6 pb-8 pt-2">
            <Button
              variant="destructive"
              className="h-11 w-full justify-center"
              onClick={() => void handleLogout()}
              disabled={loggingOut}
            >
              {loggingOut ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <LogOut className="mr-2 h-4 w-4" />
              )}
              退出登录
            </Button>
          </div>
        </DrawerContent>
      </Drawer>
    </>
  );
}
