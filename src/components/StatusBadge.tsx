import React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  MinusCircle,
  Sparkles,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { FileStatus } from "@/features/renamer/types";

interface StatusBadgeProps {
  status: FileStatus;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status }) => {
  switch (status) {
    case "ready":
      return (
        <Badge variant="success" aria-label="Status: Ready to rename">
          <CheckCircle2 className="h-3 w-3" />
          <span>Ready</span>
        </Badge>
      );
    case "needs_review":
      return (
        <Badge variant="warning" aria-label="Status: Needs Review">
          <AlertTriangle className="h-3 w-3" />
          <span>Needs Review</span>
        </Badge>
      );
    case "conflict":
      return (
        <Badge variant="destructive" aria-label="Status: Conflict">
          <XCircle className="h-3 w-3" />
          <span>Conflict</span>
        </Badge>
      );
    case "skipped":
      return (
        <Badge variant="secondary" aria-label="Status: Excluded or Unchanged">
          <MinusCircle className="h-3 w-3" />
          <span>Excluded</span>
        </Badge>
      );
    case "renamed":
      return (
        <Badge variant="default" aria-label="Status: Renamed">
          <Sparkles className="h-3 w-3" />
          <span>Renamed</span>
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="destructive" aria-label="Status: Rename Failed">
          <XCircle className="h-3 w-3" />
          <span>Failed</span>
        </Badge>
      );
  }
};
