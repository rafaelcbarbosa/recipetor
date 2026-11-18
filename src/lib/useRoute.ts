import { useCallback, useEffect, useState } from "react";

export type Route =
  | { name: "library" }
  | { name: "discover" }
  | { name: "classes" }
  | { name: "class"; id: string }
  | { name: "join"; code: string }
  | { name: "public"; id: string }
  | { name: "notifications" }
  | { name: "adminReports" }
  | { name: "privacy" }
  | { name: "notFound" };

export function parseRoute(pathname: string): Route {
  if (pathname === "/" || pathname === "") return { name: "library" };
  if (pathname === "/discover") return { name: "discover" };
  if (pathname === "/classes") return { name: "classes" };
  if (pathname === "/notifications") return { name: "notifications" };
  if (pathname === "/admin/reports") return { name: "adminReports" };
  if (pathname === "/privacy") return { name: "privacy" };
  const classMatch = pathname.match(/^\/classes\/([^/]+)\/?$/);
  if (classMatch) return { name: "class", id: decodeURIComponent(classMatch[1]) };
  const joinMatch = pathname.match(/^\/join\/([^/]+)\/?$/);
  if (joinMatch) return { name: "join", code: decodeURIComponent(joinMatch[1]) };
  const publicMatch = pathname.match(/^\/r\/([^/]+)\/?$/);
  if (publicMatch) return { name: "public", id: decodeURIComponent(publicMatch[1]) };
  return { name: "notFound" };
}

export function useRoute() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));

  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((to: string, { replace = false }: { replace?: boolean } = {}) => {
    if (to === window.location.pathname) return;
    if (replace) window.history.replaceState(null, "", to);
    else window.history.pushState(null, "", to);
    setRoute(parseRoute(to));
    window.scrollTo({ top: 0 });
  }, []);

  return { route, navigate };
}
