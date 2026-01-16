import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';

interface UpdatePromptDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description: string;
    onConfirm: () => void;
    onCancel: () => void;
    isUpdating: boolean;
}

export function UpdatePromptDialog({
    open,
    onOpenChange,
    title,
    description,
    onConfirm,
    onCancel,
    isUpdating,
}: UpdatePromptDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>{description}</DialogDescription>
                </DialogHeader>
                <DialogFooter>
                    <Button variant="outline" onClick={onCancel} disabled={isUpdating}>
                        Later
                    </Button>
                    <Button onClick={onConfirm} disabled={isUpdating} className="gap-2">
                        {isUpdating && <Loader2 className="h-4 w-4 animate-spin" />}
                        Update video
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
