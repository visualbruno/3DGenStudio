# 🔌 ComfyUI - Generate a Mesh with Trellis 2

### Create the workflow in ComfyUI
<img width="1176" height="564" alt="{9C094CAE-3C08-46FB-93B4-6AE52BB8D04D}" src="https://github.com/user-attachments/assets/3edd4ba2-dcf1-46d7-9a0f-386130e2feed" />

*Don't forget to put the "Preview 3D", because it will be used as the output in 3D Gen Studio*

Export the workflow using "Export (API)"
<img width="231" height="331" alt="{A3775E1F-AA8F-4E18-9A38-4E0B54331DE2}" src="https://github.com/user-attachments/assets/c9e01ff1-d64c-4bc7-9fdc-acddd877237d" />

### Import the workflow from the Assets page
<img width="1241" height="641" alt="{EBEC25D9-3146-4951-8C29-3658EF27AD66}" src="https://github.com/user-attachments/assets/69e5824a-82ad-4bd4-97fc-62693ec6cfde" />

1) Unselect all input parameters
2) Choose the type "Mesh" for the output parameter
<img width="185" height="344" alt="{70B73A4C-0A4C-4083-8039-87AAB4E51156}" src="https://github.com/user-attachments/assets/434242af-d83a-418a-93a3-bcb1f97aad67" />

3) Find the input "Trellis 2 Load Image" and set the type as "Image" and check it. Rename the input as "Source Image"
<img width="259" height="297" alt="{5036FAAE-C8EB-4D1D-9BBC-029061603688}" src="https://github.com/user-attachments/assets/6caae2e7-b703-4525-aa24-884d4954780c" />

4) Find the input "seed" and check it. Rename it as "Seed"
<img width="208" height="152" alt="{775B26D8-1933-4232-B7E4-9861E83A0AAA}" src="https://github.com/user-attachments/assets/c8ebca65-c98f-446d-962b-3887056fa72c" />

5) Find the input "texture_size", check it and rename it as "Texture Size"
<img width="218" height="155" alt="{753F8481-F8FB-4567-B8C2-274B1F930FE8}" src="https://github.com/user-attachments/assets/dc2d4f2d-bc6a-4416-b7e4-9db50cfaeb75" />

6) Find the input "target_face_num", check it and rename it "Target Face Number"
<img width="216" height="154" alt="{F959390D-F842-419E-922A-4FD56BE1C6AE}" src="https://github.com/user-attachments/assets/076da015-b68c-4afe-8585-5c4dae95628e" />

7) You can check any other input parameter that you want to change in the workflow. Save your workflow with the button "Save Workflow" that is at the bottom of the page

### Generate the mesh from the Graph Worflow
<img width="1262" height="636" alt="{CF882F11-9610-47A8-BAC6-415CBA16C870}" src="https://github.com/user-attachments/assets/a0ca5a9d-85da-46a1-8a47-b141055186ea" />

**Trellis 2 works only with transparent image, so you can use another Image node to remove the background using another ComfyUI workflow for that**

Create a workflow that will remove the background first and import it in 3D Gen Studio
<img width="1259" height="649" alt="{7646ED94-062F-4457-8FFD-796D517471DE}" src="https://github.com/user-attachments/assets/9c5fd5f5-3bce-45f9-9af2-1951ca660339" />

Run the workflow
<img width="632" height="369" alt="{75E0F255-9A5C-418A-A49C-9C4BC95F89D0}" src="https://github.com/user-attachments/assets/4dc14fd2-7321-43fd-a9f4-d3c5fcc7915e" />

Now you have your transparent picture, add a "Mesh" node and connect your transparent picture to the "Mesh" node
<img width="1251" height="669" alt="{7FEC2AEC-7730-4566-8791-3AC124CAE554}" src="https://github.com/user-attachments/assets/8f3881f9-4259-4de2-9eea-4166931fa550" />

Run your Trellis 2 Workflow and wait for the result
<img width="319" height="426" alt="{252530AA-456B-4EF1-BB7E-90C4C43E0FCD}" src="https://github.com/user-attachments/assets/7205092f-9352-499f-b074-d92053fae418" />
<img width="432" height="524" alt="{C59BF821-84A4-4421-AE50-9DB1F89D27E9}" src="https://github.com/user-attachments/assets/c5e318c2-d9c7-4f29-ad17-0000c429b5f6" />
<img width="429" height="513" alt="{0C337F8A-2DC6-4323-AC7D-7212E2E11743}" src="https://github.com/user-attachments/assets/6688d952-d9ae-4c43-a9d4-7f8456ca2849" />

You will find all your generated images and meshes in the Assets page


