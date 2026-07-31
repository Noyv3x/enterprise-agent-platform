/* <Brand/> — deployment-configurable logo/name and Agent label. */

import { useEffect, useState } from "react";
import { useBranding } from "../../context/BrandingContext";
import { cx } from "../../lib/cx";

export function Brand({ className }: { className?: string }) {
  const { branding } = useBranding();
  const [logoFailed, setLogoFailed] = useState(false);

  useEffect(() => setLogoFailed(false), [branding.logo_url]);

  return (
    <div className={cx("brand", className)}>
      {branding.logo_url && !logoFailed ? (
        <img
          className="brand__logo"
          src={branding.logo_url}
          alt={branding.product_name}
          onError={() => setLogoFailed(true)}
        />
      ) : (
        <span className="brand__name">{branding.product_name}</span>
      )}
      <span className="brand__eyebrow">{branding.agent_name}</span>
    </div>
  );
}
