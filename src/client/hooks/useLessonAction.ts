import { api } from "@client/lib/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

type ActionInput = { lessonId: string; reason?: string };

function postLesson(action: string, withBody: boolean) {
  return ({ lessonId, reason }: ActionInput) =>
    api(`/api/lessons/${lessonId}/${action}`, {
      method: "POST",
      body: withBody ? JSON.stringify({ reason }) : undefined,
    });
}

export function useLessonAction() {
  const qc = useQueryClient();
  const onDone = (label: string) => () => {
    qc.invalidateQueries({ queryKey: ["lessons"] });
    qc.invalidateQueries({ queryKey: ["lesson-counts"] });
    toast.success(label);
  };
  const onErr = (err: unknown) => toast.error(`Échec : ${(err as Error).message}`);

  const approve = useMutation({
    mutationFn: postLesson("approve", false),
    onSuccess: onDone("Leçon approuvée"),
    onError: onErr,
  });
  const reject = useMutation({
    mutationFn: postLesson("reject", true),
    onSuccess: onDone("Leçon rejetée"),
    onError: onErr,
  });
  const pin = useMutation({
    mutationFn: postLesson("pin", false),
    onSuccess: onDone("Leçon épinglée"),
    onError: onErr,
  });
  const unpin = useMutation({
    mutationFn: postLesson("unpin", false),
    onSuccess: onDone("Leçon désépinglée"),
    onError: onErr,
  });
  const archive = useMutation({
    mutationFn: postLesson("archive", true),
    onSuccess: onDone("Leçon archivée"),
    onError: onErr,
  });

  return { approve, reject, pin, unpin, archive };
}
