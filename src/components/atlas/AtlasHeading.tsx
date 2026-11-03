import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

/** Shared page title. Status and counts here come from the current view. */
export function AtlasHeading({title,icon:Icon,description,actions,meta}:{
  title:string; icon:LucideIcon; description?:string; actions?:ReactNode; meta?:ReactNode;
}) {
  return <div className="atlas-heading">
    <div className="atlas-heading-main">
      <span className="atlas-heading-icon" aria-hidden="true"><Icon size={19} strokeWidth={1.65}/></span>
      <div><h2>{title}</h2>{description && <p>{description}</p>}</div>
      {meta}
    </div>
    {actions && <div className="atlas-heading-actions">{actions}</div>}
  </div>;
}
